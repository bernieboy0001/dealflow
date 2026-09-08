import { existsSync, readFileSync } from 'node:fs';
import { ASSET_UNIT, parseAssetMicro, parseMicro, toAssetDecimal, toDecimal } from './domain/money.js';
import type { MarketSource } from './market.js';
import { STATE_KEYS, type StateStore, saveText } from './storage.js';
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
  private readonly store?: StateStore;
  private readonly storeKey: string;

  constructor(opts: {
    market: MarketSource;
    seed?: Seed;
    id?: string;
    stateFile?: string;
    store?: StateStore;
    storeKey?: string;
  }) {
    this.market = opts.market;
    this.id = opts.id ?? 'df-sub-01';
    this.stateFile = opts.stateFile;
    this.store = opts.store;
    this.storeKey = opts.storeKey ?? STATE_KEYS.account;
    // durable-store restores via create(); the file is the local fallback
    const persisted = this.store ? null : this.stateFile ? readSnapshot(this.stateFile) : null;
    const seed = persisted ?? opts.seed ?? DEFAULT_SEED;
    this.balances = Object.fromEntries(
      Object.entries(seed.balances).map(([s, q]) => [s, parseAssetMicro(q)]),
    );
    this.cashMicro = parseMicro(seed.cash);
  }

  /** Async boot that can read the initial snapshot from a durable store. */
  static async create(opts: {
    market: MarketSource;
    seed?: Seed;
    id?: string;
    stateFile?: string;
    store?: StateStore;
    storeKey?: string;
  }): Promise<VirtualSubaccount> {
    let persisted: SubaccountSnapshot | null = null;
    if (opts.store) {
      const raw = await opts.store.get(opts.storeKey ?? STATE_KEYS.account);
      if (raw) {
        try {
          persisted = JSON.parse(raw) as SubaccountSnapshot;
        } catch {
          // corrupted snapshot — start from the seed
        }
      }
    }
    return new VirtualSubaccount({ ...opts, seed: persisted ?? opts.seed });
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
    if (this.stateFile || this.store) this.flushSnapshot();
    return out;
  }

  private snapshot(): SubaccountSnapshot {
    return {
      balances: Object.fromEntries(Object.entries(this.balances).map(([s, q]) => [s, toAssetDecimal(q)])),
      cash: toDecimal(this.cashMicro),
    };
  }

  private flushSnapshot(): void {
    if (!this.stateFile && !this.store) return;
    saveText(this.store, this.storeKey, this.stateFile ?? '', JSON.stringify(this.snapshot()));
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
