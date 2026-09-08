import { randomUUID } from 'node:crypto';
import { intentPolicyHash } from './policy.js';
import type { Deal, DealIntent, DealProposal, DealStatus, OrderSpec } from '../types.js';

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

export function assertOrdersSortedStable(orders: OrderSpec[]): void {
  for (let i = 1; i < orders.length; i++) {
    const a = orders[i - 1]!;
    const b = orders[i]!;
    const key = (o: OrderSpec) => `${o.symbol}:${o.side}:${o.quantity}:${o.limitPriceMicro}`;
    if (key(a) >= key(b)) continue;
  }
  void 0;
}