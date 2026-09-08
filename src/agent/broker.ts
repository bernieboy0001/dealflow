import { createHash } from 'node:crypto';
import { portfolioWeights } from '../account.js';
import { sortDealOrders } from '../domain/deal.js';
import {
  ASSET_UNIT,
  applyBps,
  notionalOf,
  parseMicro,
  quantityFromNotional,
  toAssetDecimal,
  toDecimal,
  toMicro,
} from '../domain/money.js';
import { POLICY, policyHash } from '../domain/policy.js';
import type { MarketSource } from '../market.js';
import type { DealProposal, OrderSpec, Side, Subaccount } from '../types.js';

export interface BrokerOpts {
  workerId: string;
  market: MarketSource;
  maxSlippageBps?: number;
  feeUsdc?: string; // price of the deal to the principal, charged to worker after verification
}

/**
 * The Broker. Turns a goal ("rebalance to 50/25/25") into a priced, bounded,
 * deterministic deal the human can sign. No randomness, no floats: every order
 * is integer math against policy caps.
 */
export class Broker {
  private readonly slippageBps: number;
  readonly feeMicro: bigint;
  readonly workerId: string;

  constructor(
    private readonly acc: Subaccount,
    private readonly opts: BrokerOpts,
  ) {
    this.slippageBps = opts.maxSlippageBps ?? POLICY.maxSlippageBps;
    this.feeMicro = toMicro(Number(opts.feeUsdc ?? '12.50'));
    this.workerId = opts.workerId;
  }

  async propose(job: string, targetWeightsInput: { [symbol: string]: number }): Promise<DealProposal> {
    const symbols = Object.keys(targetWeightsInput);
    const { navAtomic, weights, positions } = await portfolioWeights(this.acc, symbols);

    // validate weights by policy (sum <= 1, each <= maxHoldingWeight)
    const sum = Object.values(targetWeightsInput).reduce((a, b) => a + b, 0);
    if (sum > 1 + 1e-9) throw new Error(`target weights sum to ${sum} > 1`);
    for (const [s, w] of Object.entries(targetWeightsInput)) {
      if (w > POLICY.maxHoldingWeight) throw new Error(`target weight for ${s} too high`);
    }

    const quotes = new Map<string, Awaited<ReturnType<MarketSource['quote']>>>();
    for (const s of symbols) quotes.set(s, await this.opts.market.quote(s));

    const orders: {
      symbol: string;
      side: Side;
      quantity: bigint;
      limitPriceMicro: bigint;
      slippageBps: number;
    }[] = [];
    for (const s of symbols) {
      const target = (navAtomic * BigInt(Math.round(targetWeightsInput[s]! * 1_000_000))) / 10n ** 6n;
      const current = parseMicro(positions.valuesUsd[s] ?? '0.000000');
      const diff = target - current;
      const abs = diff < 0n ? -diff : diff;
      const min = toMicro(10); // $10 minimum trade
      if (abs < min) continue;
      const q = quotes.get(s)!;
      const side: Side = diff >= 0n ? 'buy' : 'sell';
      const priceMicro = parseMicro(side === 'buy' ? q.ask : q.bid);
      const quantity = quantityFromNotional(abs, priceMicro);
      if (quantity <= 0n) continue;
      const limitPriceMicro = applyBps(priceMicro, this.slippageBps, side);
      orders.push({ symbol: s, side, quantity, limitPriceMicro, slippageBps: this.slippageBps });
    }

    if (orders.length === 0) {
      throw new Error('portfolio already at target weights — tweak a target to open a new deal');
    }

    // funding-aware sizing: buys may never exceed cash on hand + proceeds from the
    // sells in this same deal, minus reserves for exchange fees. No hidden deficit.
    let budget = await this.acc.cashReservedAtomic();
    const feeBps = BigInt(POLICY.maxTotalFeeBps);
    const sells = orders.filter((o) => o.side === 'sell');
    for (const s of sells) {
      const proceeds = notionalOf(s.quantity, s.limitPriceMicro);
      const fee = (proceeds * feeBps) / 10_000n;
      budget += proceeds - fee; // net proceeds, sell-side fees included
    }
    const sized = orders.map((o) => {
      if (o.side === 'sell') return o;
      const gross = notionalOf(o.quantity, o.limitPriceMicro);
      const fee = (gross * feeBps) / 10_000n;
      const need = gross + fee;
      if (need <= budget) {
        budget -= need;
        return o;
      }
      // scale this buy down to what is actually fundable (fee-inclusive)
      if (budget <= 0n) return null;
      const feeInclusive = (budget * 10_000n) / (10_000n + feeBps);
      const qty = (feeInclusive * ASSET_UNIT) / o.limitPriceMicro;
      budget -= notionalOf(qty, o.limitPriceMicro) + (notionalOf(qty, o.limitPriceMicro) * feeBps) / 10_000n;
      return qty > 0n ? { ...o, quantity: qty } : null;
    });

    const funded = sized.filter((o): o is NonNullable<typeof o> => o !== null && o.quantity > 0n);
    if (funded.length === 0) {
      throw new Error('no order is fundable under the current policy and balance');
    }
    const orders1 = funded;

    const orderSpecs: OrderSpec[] = sortDealOrders(
      orders1.map((o) => ({
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity.toString(),
        limitPriceMicro: o.limitPriceMicro.toString(),
        maxSlippageBps: o.slippageBps,
        clientOrderId: deterministicOrderId(o.symbol, o.side, o.quantity, o.limitPriceMicro, this.workerId),
      })),
    );

    const maxNotionalAtomic = orderSpecs.reduce(
      (a, o) => (o.side === 'buy' ? a + notionalOf(BigInt(o.quantity), BigInt(o.limitPriceMicro)) : a),
      0n,
    );

    const expectedFeeAtomic = orderSpecs.reduce(
      (a, o) =>
        a +
        (notionalOf(BigInt(o.quantity), BigInt(o.limitPriceMicro)) * BigInt(POLICY.maxTotalFeeBps)) / 10_000n,
      0n,
    );

    return {
      workerId: this.workerId,
      nonce: Date.now() % 1_000_000,
      job,
      orders: orderSpecs,
      maxNotionalAtomic: maxNotionalAtomic.toString(),
      maxFeeAtomic: POLICY.maxFeeAtomic.toString(),
      expectedFeeAtomic: expectedFeeAtomic.toString(),
      maxSlippageBps: this.slippageBps,
      targetWeights: Object.fromEntries(
        Object.entries(targetWeightsInput).map(([s, w]) => [s, w.toFixed(4)]),
      ),
      beforeWeights: Object.fromEntries(
        symbols.map((s) => [s, (Number(weights[s]) / 10_000_000).toFixed(4)]),
      ),
      feeAtomic: this.feeMicro.toString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      policyHash: policyHash(),
      summaryLines: buildSummary(orderSpecs, expectedFeeAtomic, this.feeMicro),
    };
  }
}

function deterministicOrderId(
  symbol: string,
  side: Side,
  quantity: bigint,
  limit: bigint,
  workerId: string,
): string {
  return createHash('sha256')
    .update([workerId, symbol, side, quantity.toString(), limit.toString()].join('|'))
    .digest('hex')
    .slice(0, 20)
    .toUpperCase();
}

function buildSummary(orders: OrderSpec[], expectedFeeAtomic: bigint, feeMicro: bigint): string[] {
  const lines = [`Broker proposes a ${orders.length}-leg rebalance`];
  for (const o of orders) {
    lines.push(
      `-> ${o.side === 'buy' ? 'buy' : 'sell'} ${toAssetDecimal(BigInt(o.quantity))} ${o.symbol} @ <= $${toDecimal(BigInt(o.limitPriceMicro))}`,
    );
  }
  lines.push(`expected exchange fees: $${toDecimal(expectedFeeAtomic)}`);
  lines.push(`Broker fee (paid only after verification): $${toDecimal(feeMicro)}`);
  return lines;
}
