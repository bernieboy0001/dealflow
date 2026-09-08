import { randomUUID } from 'node:crypto';
import type { Deal, DealIntent, DealProposal, DealStatus, OrderSpec } from '../types.js';
import { intentPolicyHash } from './policy.js';

const FLOW: Record<DealStatus, DealStatus[]> = {
  proposing: ['proposed', 'failed'],
  proposed: ['approved', 'rejected', 'cancelled', 'failed'],
  approved: ['executing', 'cancelled', 'failed'],
  executing: ['executed', 'failed'],
  executed: ['verified', 'failed'],
  verified: ['settled', 'cancelled'],
  settled: [],
  rejected: [],
  cancelled: [],
  failed: [],
};

export function createDeal(proposal: DealProposal): Deal {
  const now = new Date().toISOString();
  return {
    ...proposal,
    id: randomUUID(),
    status: 'proposed',
    receipts: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function toIntent(p: DealProposal, orderIndex: number, deadline: number): DealIntent {
  const order = p.orders[orderIndex];
  if (!order) throw new Error('toIntent: no order at index');
  return {
    workerId: p.workerId,
    nonce: p.nonce + orderIndex,
    job: p.job,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    limitPriceMicro: order.limitPriceMicro,
    maxNotionalAtomic: p.maxNotionalAtomic,
    maxSlippageBps: order.maxSlippageBps,
    feeAtomic: p.feeAtomic,
    deadline,
    policyHash: intentPolicyHash(p),
  };
}

export function transition(deal: Deal, next: DealStatus, reason?: string): Deal {
  if (!FLOW[deal.status].includes(next)) {
    throw new Error(`invalid transition ${deal.status} -> ${next}${reason ? ` (${reason})` : ''}`);
  }
  return { ...deal, status: next, updatedAt: new Date().toISOString() };
}

/**
 * Canonical deal order: sells before buys so the subaccount is funded at
 * execution time (a deal must be self-funding), then a deterministic key so the
 * signed intent binds the same sequence every time regardless of input order.
 */
export function canonicalOrderKey(o: OrderSpec): string {
  const sideRank = o.side === 'sell' ? '0' : '1';
  return `${sideRank}:${o.symbol}:${o.quantity}:${o.limitPriceMicro}`;
}

export function sortDealOrders(orders: OrderSpec[]): OrderSpec[] {
  return [...orders].sort((a, b) => {
    const ka = canonicalOrderKey(a);
    const kb = canonicalOrderKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Throws unless the orders live in canonical deal order (sells first, stable ties). */
export function assertOrdersSortedStable(orders: OrderSpec[]): void {
  const sorted = sortDealOrders(orders);
  for (let i = 0; i < orders.length; i++) {
    if (canonicalOrderKey(orders[i]!) !== canonicalOrderKey(sorted[i]!)) {
      const a = orders[i]!.symbol;
      const b = sorted[i]!.symbol;
      throw new Error(
        `orders are not in canonical deal order (${i}: ${a}:${orders[i]!.side} vs ${b}:${sorted[i]!.side})`,
      );
    }
  }
}
