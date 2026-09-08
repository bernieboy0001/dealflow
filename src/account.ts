import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ASSET_UNIT, parseAssetMicro, parseMicro, toAssetDecimal, toDecimal } from './domain/money.js';
import type { MarketSource } from './market.js';
import type { Positions, Receipt, Subaccount } from './types.js';

export type { Subaccount };

export interface Seed {
  balances: { [symbol: string]: string };
  cash: string;
}

/** What a VirtualSubaccount persists across restarts. */
export interface SubaccountSnapshot {
  balances: { [symbol: string]: string };
  cash: string;
}

const DEFAULT_SEED: Seed = {
  balances: { BTC: '0.0068', ETH: '0.05', SOL: '0.5' },
  cash: '500.00',
};

export class VirtualSubaccount implements Subaccount {
  readonly id: string;
  private cashMicro: bigint;
  private balances: { [symbol: string]: bigint }; // asset quantities at 6dp scale
  private readonly market: MarketSource;
  private readonly stateFile?: string;

  constructor(opts: { market: MarketSource; seed?: Seed; id?: string; stateFile?: string }) {
    this.market = opts.market;
    this.id = opts.id ?? 'df-sub-01';
    this.stateFile = opts.stateFile;
    const persisted = this.stateFile ? readSnapshot(this.stateFile) : null;
    const seed = persisted ?? opts.seed ?? DEFAULT_SEED;
    this.balances = Object.fromEntries(
      Object.entries(seed.balances).map(([s, q]) => [s, parseAssetMicro(q)]),
    );
    this.cashMicro = parseMicro(seed.cash);
  }

  private cached?: Positions;
  private async buildPositions(symbols: string[]): Promise<Positions> {
    const quotes = await this.market.quotes(symbols);
    const balances: Positions['balances'] = {};
    const valuesUsd: Positions['valuesUsd'] = {};
    const navParts: bigint[] = [this.cashMicro];
    for (const q of quotes) {
      const qty = this.balances[q.symbol] ?? 0n;
      const priceMicro = parseMicro(q.price);
      const value = (qty * priceMicro) / ASSET_UNIT;
      balances[q.symbol] = qty.toString();
      valuesUsd[q.symbol] = toDecimal(value);
      navParts.push(value);
    }
    const nav = navParts.reduce((a, b) => a + b, 0n);
    return {
      balances,
      valuesUsd,
      cashAtomic: this.cashMicro.toString(),
      baseCurrency: 'USDC',
      fetchedAt: new Date().toISOString(),
      _navAtomic: nav,
    } as Positions & { _navAtomic: bigint };
  }

  async positions(symbols: string[]): Promise<Positions> {
    if (!this.cached) this.cached = await this.buildPositions(symbols);
    return this.cached;
  }

  cashReservedAtomic(): bigint {
    return this.cashMicro;
  }

  /** Simulated fill: consume cash on buys, credit on sells, at limit price bounded by maxSlippage. */
  async execute(receipts: Receipt[]): Promise<Receipt[]> {
    const out: Receipt[] = [];
    for (const r of receipts) {
      const qty = BigInt(r.quantity);
      const price = BigInt(r.priceMicro);
      const fee = BigInt(r.feeMicro);
      if (r.side === 'buy') {
        const cost = (qty * price) / ASSET_UNIT + fee;
        if (cost > this.cashMicro) {
          out.push({ ...r, status: 'rejected', at: new Date().toISOString() });
          continue;
        }
        this.cashMicro -= cost;
        this.balances[r.symbol] = (this.balances[r.symbol] ?? 0n) + qty;
      } else {
        const have = this.balances[r.symbol] ?? 0n;
        if (qty > have) {
          out.push({ ...r, status: 'rejected', at: new Date().toISOString() });
          continue;
        }
        const proceeds = (qty * price) / ASSET_UNIT - fee;
        this.cashMicro += proceeds;
        this.balances[r.symbol] = have - qty;
      }
      this.cached = undefined;
      out.push({ ...r, status: 'filled', at: new Date().toISOString() });
    }
    if (this.stateFile) this.flushSnapshot();
    return out;
  }

  private snapshot(): SubaccountSnapshot {
    return {
      balances: Object.fromEntries(Object.entries(this.balances).map(([s, q]) => [s, toAssetDecimal(q)])),
      cash: toDecimal(this.cashMicro),
    };
  }

  private flushSnapshot(): void {
    try {
      mkdirSync(dirname(this.stateFile!), { recursive: true });
      writeFileSync(this.stateFile!, JSON.stringify(this.snapshot()));
    } catch {
      // read-only filesystem (Vercel serverless) — balances stay in memory only
    }
  }
}

function readSnapshot(file: string): SubaccountSnapshot | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as SubaccountSnapshot;
  } catch {
    return null;
  }
}

function computeNav(p: Positions): bigint {
  const parts = [BigInt(p.cashAtomic)];
  for (const v of Object.values(p.valuesUsd)) parts.push(parseMicro(v));
  return parts.reduce((a, b) => a + b, 0n);
}

/** Convenience: NAV + weights used by the broker for a plan. */
export async function portfolioWeights(
  acc: Subaccount,
  symbols: string[],
): Promise<{
  navAtomic: bigint;
  weights: { [symbol: string]: string }; // numerator/1e6
  cashWeight: string;
  positions: Positions;
}> {
  const positions = await acc.positions(symbols);
  const nav = (positions as Positions & { _navAtomic?: bigint })._navAtomic ?? computeNav(positions);
  const weights: { [symbol: string]: string } = {};
  for (const [sym, v] of Object.entries(positions.valuesUsd)) {
    weights[sym] = ((parseMicro(v) * 10_000_000n) / nav).toString(); // 7 decimals of weight
  }
  const cashWeight = ((BigInt(positions.cashAtomic) * 10_000_000n) / nav).toString();
  return { navAtomic: nav, weights, cashWeight, positions };
}
