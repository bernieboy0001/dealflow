import { createHash } from 'node:crypto';
import type { DealProposal, OrderSpec } from '../types.js';
import { ASSET_UNIT } from './money.js';

export const ALLOWED_SYMBOLS = ['BTC', 'ETH', 'SOL'] as const;
export type AllowedSymbol = (typeof ALLOWED_SYMBOLS)[number];

export const POLICY = {
  version: 1,
  allowedSymbols: ALLOWED_SYMBOLS as readonly string[],
  /** max notional value touched by one deal, in USDC atomic */
  maxNotionalAtomic: 1000n * 10n ** 6n,
  /** max worker fee charged for one deal, in USDC atomic */
  maxFeeAtomic: 50n * 10n ** 6n,
  maxSlippageBps: 25,
  maxTotalFeeBps: 10,
  /** a portfolio holding may not exceed this share of NAV */
  maxHoldingWeight: 0.6,
  /** reject a deal that trades the same symbol both sides */
  roundTrip: true,
  /** max realized loss a subaccount may book in a rolling ledger (circuit breaker) */
  drawdownCapAtomic: 100n * 10n ** 6n,
};

export function policyHash(): string {
  return createHash('sha256')
    .update(JSON.stringify(POLICY, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    .digest('hex');
}

export interface PolicyFailure {
  code: string;
  message: string;
}

export function checkProposal(p: DealProposal): PolicyFailure[] {
  const failures: PolicyFailure[] = [];
  const maxN = BigInt(p.maxNotionalAtomic);
  const maxF = BigInt(p.maxFeeAtomic);
  const fee = BigInt(p.feeAtomic);

  if (fee > maxF) {
    failures.push({ code: 'fee-cap', message: `worker fee ${p.feeAtomic} exceeds cap ${p.maxFeeAtomic}` });
  }
  if (fee <= 0n) {
    failures.push({ code: 'fee-zero', message: 'worker fee must be positive' });
  }
  if (maxN > POLICY.maxNotionalAtomic) {
    failures.push({ code: 'notional-cap', message: 'deal notional above policy cap' });
  }
  if (p.maxSlippageBps > POLICY.maxSlippageBps) {
    failures.push({ code: 'slippage-cap', message: 'slippage tolerance above policy cap' });
  }
  if (p.policyHash !== policyHash()) {
    failures.push({
      code: 'policy-version',
      message: 'policy hash mismatch (policy changed under the deal)',
    });
  }
  if (Date.parse(p.expiresAt) <= Date.now() + 10_000) {
    failures.push({ code: 'expiry', message: 'deal expires too soon' });
  }

  const symbols = new Set(p.orders.map((o) => o.symbol));
  if (POLICY.roundTrip) {
    for (const sym of symbols) {
      const sides = p.orders.filter((o) => o.symbol === sym).map((o) => o.side);
      if (new Set(sides).size > 1) {
        failures.push({ code: 'round-trip', message: `deal buys and sells ${sym}` });
      }
    }
  }

  for (const s of symbols) {
    if (!POLICY.allowedSymbols.includes(s)) {
      failures.push({ code: 'symbol', message: `${s} not on the allowlist` });
    }
  }

  // each order must fit under the deal notional *notionally* (worst case limit price)
  for (const o of p.orders) {
    const qty = BigInt(o.quantity);
    const limit = BigInt(o.limitPriceMicro);
    if (o.side === 'buy') {
      const worst = (qty * limit) / ASSET_UNIT;
      if (worst > maxN) {
        failures.push({ code: 'order-notional', message: `${o.symbol} buy can exceed deal notional` });
      }
    }
  }

  return failures;
}

export function checkOrder(order: OrderSpec): PolicyFailure[] {
  const failures: PolicyFailure[] = [];
  if (order.maxSlippageBps > POLICY.maxSlippageBps) {
    failures.push({ code: 'slippage-cap', message: 'order slippage above cap' });
  }
  if (!POLICY.allowedSymbols.includes(order.symbol)) {
    failures.push({ code: 'symbol', message: `${order.symbol} not allowed` });
  }
  if (BigInt(order.quantity) <= 0n) {
    failures.push({ code: 'quantity', message: 'non-positive quantity' });
  }
  return failures;
}

/** hash of the canonical deal fields -> binds the intent to the exact agreed deal */
export function intentPolicyHash(p: Pick<DealProposal, 'orders' | 'maxSlippageBps' | 'feeAtomic'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        orders: p.orders.map((o) => ({ ...o })),
        maxSlippageBps: p.maxSlippageBps,
        fee: p.feeAtomic,
      }),
    )
    .digest('hex');
}
