import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { VirtualSubaccount } from '../src/account.js';
import { Auditor } from '../src/agent/auditor.js';
import { Broker } from '../src/agent/broker.js';
import { createDeal, toIntent, transition } from '../src/domain/deal.js';
import { recoverSigner, signIntent } from '../src/domain/intent.js';
import {
  applyBps,
  notionalOf,
  parseAssetMicro,
  parseMicro,
  quantityFromNotional,
  toAssetDecimal,
  toDecimal,
  toMicro,
} from '../src/domain/money.js';
import { checkProposal, POLICY, policyHash } from '../src/domain/policy.js';
import { Ledger } from '../src/ledger.js';
import { fixtureQuote } from '../src/market.js';
import { Orchestrator } from '../src/orchestrator.js';
import { STATE_KEYS, type StateStore } from '../src/storage.js';
import type { Deal, DealProposal, OrderSpec, Receipt } from '../src/types.js';

const AUDITOR_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const PRINCIPAL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

function makeProposal(overrides?: Partial<DealProposal>): DealProposal {
  return {
    workerId: 'broker-1',
    nonce: 1,
    job: 'rebalance',
    orders: [
      {
        symbol: 'BTC',
        side: 'sell',
        quantity: '1000000',
        limitPriceMicro: '84000000000',
        maxSlippageBps: 15,
        clientOrderId: 'ord-1',
      },
      {
        symbol: 'ETH',
        side: 'buy',
        quantity: '200000',
        limitPriceMicro: '3150000000',
        maxSlippageBps: 15,
        clientOrderId: 'ord-2',
      },
    ],
    maxNotionalAtomic: '1000000000',
    maxFeeAtomic: '50000000',
    expectedFeeAtomic: '50000000',
    maxSlippageBps: 15,
    targetWeights: { BTC: '0.5', ETH: '0.5' },
    beforeWeights: { BTC: '0.8', ETH: '0.2' },
    feeAtomic: '50000000',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    policyHash: policyHash(),
    summaryLines: ['rebalance 50/50'],
    ...overrides,
  };
}

function makeFilledReceipts(orders: OrderSpec[]): Receipt[] {
  return orders.map((o, i) => ({
    orderId: `MRK-${i + 1}`,
    clientOrderId: o.clientOrderId,
    symbol: o.symbol,
    side: o.side,
    quantity: o.quantity,
    priceMicro: o.limitPriceMicro,
    feeMicro: String(
      Math.round((Number(o.quantity) * Number(o.limitPriceMicro) * POLICY.maxTotalFeeBps) / (1e6 * 10_000)),
    ),
    status: 'filled' as const,
    txRef: `blk-${i}`,
    at: new Date().toISOString(),
  }));
}

function makeDeal(overrides?: { intent?: boolean; filled?: boolean; policyHash?: string }): Deal {
  const proposal = makeProposal();
  const deal = createDeal(proposal);
  const intent =
    overrides?.intent !== false ? toIntent(proposal, 0, Math.floor(Date.now() / 1000) + 1800) : undefined;
  const receipts = overrides?.filled !== false ? makeFilledReceipts(proposal.orders) : [];
  return {
    ...deal,
    intent,
    policyHash: overrides?.policyHash ?? policyHash(),
    receipts,
  };
}

// ─── money ──────────────────────────────────────────────────────────────────

describe('money', () => {
  it('parseMicro + toDecimal roundtrip', () => {
    const v = parseMicro('123.456789');
    expect(v).toBe(123_456_789n);
    expect(toDecimal(v)).toBe('123.456789');
  });

  it('parseMicro negative', () => {
    expect(parseMicro('-5.00')).toBe(-5_000_000n);
    expect(toDecimal(parseMicro('-0.10'))).toBe('-0.100000');
  });

  it('toMicro from float', () => {
    expect(toMicro(12.5)).toBe(12_500_000n);
    expect(toMicro(0.01)).toBe(10_000n);
  });

  it('parseAssetMicro / toAssetDecimal roundtrip', () => {
    const v = parseAssetMicro('0.432400');
    expect(v).toBe(432_400n);
    expect(toAssetDecimal(v)).toBe('0.4324');
  });

  it('quantityFromNotional floors correctly', () => {
    // $300 budget, price $84,000/unit → 300/84000 = 0.0035714 → 3571
    const qty = quantityFromNotional(300_000_000n, 84_000_000_000n);
    expect(qty).toBe(3_571n);
    // cost ≤ budget
    expect(notionalOf(qty, 84_000_000_000n)).toBeLessThanOrEqual(300_000_000n);
  });

  it('notionalOf matches expectation', () => {
    // 1.5 BTC at $3,000 → $4,500
    const n = notionalOf(1_500_000n, 3_000_000_000n);
    expect(n).toBe(4_500_000_000n);
  });

  it('applyBps buy floors, sell ceils', () => {
    const price = 100_000_000n; // $100
    expect(applyBps(price, 15, 'buy')).toBe(100_150_000n); // floor (exact division)
    expect(applyBps(price, 15, 'sell')).toBe(100_150_000n); // ceil of exact division = same
    // asymmetric case
    const p2 = 100_000_001n;
    expect(applyBps(p2, 15, 'buy')).toBe(100_150_001n);
    expect(applyBps(p2, 15, 'sell')).toBe(100_150_002n); // ceil of non-integer
  });

  it('throws on zero price', () => {
    expect(() => quantityFromNotional(100n, 0n)).toThrow('zero price');
  });
});

// ─── policy ─────────────────────────────────────────────────────────────────

describe('policy', () => {
  it('policyHash is stable', () => {
    expect(policyHash()).toBe(policyHash());
    expect(policyHash().length).toBe(64); // sha256 hex
  });

  it('checkProposal accepts a valid deal', () => {
    const p = makeProposal();
    expect(checkProposal(p)).toEqual([]);
  });

  it('rejects fee above cap', () => {
    const p = makeProposal({ feeAtomic: '60000000' });
    const fails = checkProposal(p);
    expect(fails.some((f) => f.code === 'fee-cap')).toBe(true);
  });

  it('rejects zero fee', () => {
    const p = makeProposal({ feeAtomic: '0' });
    const fails = checkProposal(p);
    expect(fails.some((f) => f.code === 'fee-zero')).toBe(true);
  });

  it('rejects deal expiring too soon', () => {
    const p = makeProposal({ expiresAt: new Date(Date.now() + 2_000).toISOString() });
    const fails = checkProposal(p);
    expect(fails.some((f) => f.code === 'expiry')).toBe(true);
  });

  it('rejects round-trip (buy + sell same symbol)', () => {
    const p = makeProposal({
      orders: [
        {
          symbol: 'BTC',
          side: 'sell',
          quantity: '1000000',
          limitPriceMicro: '84000000000',
          maxSlippageBps: 15,
          clientOrderId: 'a',
        },
        {
          symbol: 'BTC',
          side: 'buy',
          quantity: '500000',
          limitPriceMicro: '84000000000',
          maxSlippageBps: 15,
          clientOrderId: 'b',
        },
      ],
    });
    expect(checkProposal(p).some((f) => f.code === 'round-trip')).toBe(true);
  });

  it('rejects unknown symbol', () => {
    const p = makeProposal({
      orders: [
        {
          symbol: 'DOGE',
          side: 'buy',
          quantity: '100',
          limitPriceMicro: '1000000',
          maxSlippageBps: 15,
          clientOrderId: 'x',
        },
      ],
    });
    expect(checkProposal(p).some((f) => f.code === 'symbol')).toBe(true);
  });
});

// ─── deal transitions ───────────────────────────────────────────────────────

describe('deal transitions', () => {
  it('valid transition succeeds', () => {
    const d = createDeal(makeProposal());
    expect(d.status).toBe('proposed');
    const d2 = transition(d, 'approved');
    expect(d2.status).toBe('approved');
  });

  it('invalid transition throws', () => {
    const d = createDeal(makeProposal());
    expect(() => transition(d, 'settled')).toThrow('invalid transition');
  });

  it('toIntent returns correct fields', () => {
    const p = makeProposal();
    const intent = toIntent(p, 0, 1_700_000_000);
    expect(intent.symbol).toBe('BTC');
    expect(intent.side).toBe('sell');
    expect(intent.deadline).toBe(1_700_000_000);
    expect(intent.nonce).toBe(1); // p.nonce + orderIndex
  });
});

// ─── ledger ─────────────────────────────────────────────────────────────────

describe('ledger', () => {
  it('append → verify passes', () => {
    const ledger = new Ledger('.local/test-ledger.json');
    ledger.append('a', { x: 1 });
    ledger.append('b', { x: 2 });
    expect(ledger.verify()).toBe(true);
    expect(ledger.seq).toBe(2);
    expect(ledger.all()[0].prevHash).toBe('genesis');
  });

  it('root is deterministic', () => {
    const l1 = new Ledger('.local/a.json');
    l1.append('k', 'v');
    const l2 = new Ledger('.local/b.json');
    l2.append('k', 'v');
    expect(l1.root()).toBe(l2.root());
  });

  it('tampered entry fails verify', () => {
    const file = '.local/t.json';
    const ledger = new Ledger(file);
    ledger.append('event.a', { n: 1 });
    // rewire the on-disk chain: rewrite entry 1's payload without recomputing its hash
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      seq: number;
      payload: unknown;
      hash: string;
    }[];
    stored[0] = { ...stored[0], payload: { n: 2 } };
    writeFileSync(file, JSON.stringify(stored));
    const reloaded = Ledger.load(file);
    expect(reloaded.verify()).toBe(false); // chain no longer recomputes to a valid root
  });

  it('byKind filters', () => {
    const ledger = new Ledger('.local/bk.json');
    ledger.append('event.a', { n: 1 });
    ledger.append('event.b', { n: 2 });
    ledger.append('event.a', { n: 3 });
    expect(ledger.byKind('event.a')).toHaveLength(2);
    expect(ledger.byKind('event.b')).toHaveLength(1);
  });

  it('emergency stop survives a restart until an explicit resume', async () => {
    const market = { quote: fixtureQuote, quotes: (syms: string[]) => Promise.all(syms.map(fixtureQuote)) };
    const boot = () => {
      const ledger = Ledger.load('.local/guardrail.json');
      const subaccount = new VirtualSubaccount({
        market,
        seed: { balances: { BTC: '1000000' }, cash: '500' },
      });
      const broker = new Broker(subaccount, { workerId: 'broker-1', market });
      const auditor = new Auditor({ auditorId: 'aud-1', privateKey: AUDITOR_KEY });
      return new Orchestrator({
        broker,
        auditor,
        subaccount,
        principalPrivateKey: PRINCIPAL_KEY,
        workerPayTo: privateKeyToAccount(AUDITOR_KEY).address,
        ledger,
      });
    };
    // stop, then a fresh orchestrator over the same chain must boot stopped
    boot().stop();
    expect(boot().alive()).toBe(false);
    await expect(boot().propose('rebalance', { BTC: 1 })).rejects.toThrow('emergency stop engaged');
    // ... and an explicit resume lifts it for the next boot
    boot().resume();
    expect(boot().alive()).toBe(true);
  });
});

// ─── virtual subaccount ─────────────────────────────────────────────────────

describe('VirtualSubaccount', () => {
  const market = { quote: fixtureQuote, quotes: (syms: string[]) => Promise.all(syms.map(fixtureQuote)) };

  it('execute buy fills and debits cash', async () => {
    const acc = new VirtualSubaccount({ market, seed: { balances: { BTC: '0' }, cash: '500' } });
    const receipt: Receipt = {
      orderId: 'm1',
      clientOrderId: 'c1',
      symbol: 'BTC',
      side: 'buy',
      quantity: '5950',
      priceMicro: '84000000000',
      feeMicro: '50000',
      status: 'filled',
      txRef: 'blk-0',
      at: new Date().toISOString(),
    };
    const [result] = await acc.execute([receipt]);
    expect(result.status).toBe('filled');
    expect(acc.cashReservedAtomic()).toBeLessThan(500_000_000n);
    const pos = await acc.positions(['BTC']);
    expect(pos.balances.BTC).toBe('5950');
  });

  it('execute buy rejected when insufficient cash', async () => {
    const acc = new VirtualSubaccount({ market, seed: { balances: { BTC: '0' }, cash: '1' } });
    const receipt: Receipt = {
      orderId: 'm2',
      clientOrderId: 'c2',
      symbol: 'BTC',
      side: 'buy',
      quantity: '3571000',
      priceMicro: '84000000000',
      feeMicro: '300000',
      status: 'filled',
      txRef: 'blk-0',
      at: new Date().toISOString(),
    };
    const [result] = await acc.execute([receipt]);
    expect(result.status).toBe('rejected');
  });

  it('execute sell rejected when insufficient asset', async () => {
    const acc = new VirtualSubaccount({ market, seed: { balances: { BTC: '0' }, cash: '500' } });
    const receipt: Receipt = {
      orderId: 'm3',
      clientOrderId: 'c3',
      symbol: 'BTC',
      side: 'sell',
      quantity: '1000000',
      priceMicro: '84000000000',
      feeMicro: '300000',
      status: 'filled',
      txRef: 'blk-0',
      at: new Date().toISOString(),
    };
    const [result] = await acc.execute([receipt]);
    expect(result.status).toBe('rejected');
  });

  it('persists balances and cash across instances', async () => {
    const file = '.local/snap-acc.json';
    rmSync(file, { force: true });
    const market = { quote: fixtureQuote, quotes: (syms: string[]) => Promise.all(syms.map(fixtureQuote)) };
    const keep = { balances: { BTC: '0' }, cash: '500' };
    const a = new VirtualSubaccount({ market, seed: keep, stateFile: file });
    const receipt: Receipt = {
      orderId: 'p1',
      clientOrderId: 'c1',
      symbol: 'BTC',
      side: 'buy',
      quantity: '5950',
      priceMicro: '84000000000',
      feeMicro: '50000',
      status: 'filled',
      txRef: 'blk-0',
      at: new Date().toISOString(),
    };
    await a.execute([receipt]);

    const b = new VirtualSubaccount({ market, seed: keep, stateFile: file }); // restart
    const pos = await b.positions(['BTC']);
    expect(pos.balances.BTC).toBe('5950'); // buy survived the restart
    expect(b.cashReservedAtomic()).toBeLessThan(500_000_000n);
  });
});

// ─── deal snapshot persistence ───────────────────────────────────────────────

describe('deal snapshot', () => {
  it('in-flight deals survive a restart via snapshot', async () => {
    const file = '.local/snap-deals.json';
    rmSync(file, { force: true });
    const market = { quote: fixtureQuote, quotes: (syms: string[]) => Promise.all(syms.map(fixtureQuote)) };
    const boot = () => {
      const ledger = new Ledger('.local/snap-ledger.json');
      const subaccount = new VirtualSubaccount({
        market,
        seed: { balances: { BTC: '0.0068', ETH: '0.05', SOL: '0.5' }, cash: '500' },
      });
      const broker = new Broker(subaccount, { workerId: 'broker-1', market });
      const auditor = new Auditor({ auditorId: 'aud-1', privateKey: AUDITOR_KEY });
      return new Orchestrator({
        broker,
        auditor,
        subaccount,
        principalPrivateKey: PRINCIPAL_KEY,
        workerPayTo: privateKeyToAccount(AUDITOR_KEY).address,
        ledger,
        dealsFile: file,
      });
    };
    const o1 = boot();
    const deal = await o1.propose('rebalance', { BTC: 0.4, ETH: 0.3 });

    const o2 = boot(); // restart
    expect(o2.list()).toHaveLength(1);
    expect(o2.get(deal.id)?.status).toBe('proposed');
    expect(o2.get(deal.id)?.job).toBe('rebalance');
  });
});

// ─── auditor ────────────────────────────────────────────────────────────────

describe('Auditor', () => {
  it('all checks pass on valid deal', async () => {
    const auditor = new Auditor({ auditorId: 'aud-1', privateKey: AUDITOR_KEY });
    const deal = makeDeal();
    const verdict = await auditor.audit(deal);
    expect(verdict.passed).toBe(true);
    expect(verdict.checks[0].name).toBe('all');
    expect(verdict.signedBy).toBe(privateKeyToAccount(AUDITOR_KEY).address);
  });

  it('fails when receipt missing', async () => {
    const auditor = new Auditor({ auditorId: 'aud-2', privateKey: AUDITOR_KEY });
    const deal = makeDeal({ filled: false });
    const verdict = await auditor.audit(deal);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.some((c) => c.name === 'receipt' && !c.ok)).toBe(true);
  });

  it('fails when intent absent', async () => {
    const auditor = new Auditor({ auditorId: 'aud-3', privateKey: AUDITOR_KEY });
    const deal = makeDeal({ intent: false });
    const verdict = await auditor.audit(deal);
    expect(verdict.passed).toBe(false);
  });
});

// ─── signature roundtrip ────────────────────────────────────────────────────

describe('EIP-712 intent signature', () => {
  it('sign + recover returns the same signer', async () => {
    const proposal = makeProposal();
    const intent = toIntent(proposal, 0, Math.floor(Date.now() / 1000) + 1800);
    const sig = await signIntent(intent, PRINCIPAL_KEY);
    const recovered = await recoverSigner(intent, sig as `0x${string}`);
    // principal key 0xac09... = address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (hardhat #0)
    expect(recovered.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });

  it('wrong key recovers different address', async () => {
    const proposal = makeProposal();
    const intent = toIntent(proposal, 0, Math.floor(Date.now() / 1000) + 1800);
    const sig = await signIntent(intent, AUDITOR_KEY);
    const recovered = await recoverSigner(intent, sig as `0x${string}`);
    expect(recovered.toLowerCase()).not.toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });
});

// ─── durable store (Vercel KV / Upstash Redis) ──────────────────────────────

class MemStore implements StateStore {
  readonly m = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.m.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.m.set(key, value);
    return Promise.resolve();
  }
}

describe('durable state via a store', () => {
  const market = { quote: fixtureQuote, quotes: (syms: string[]) => Promise.all(syms.map(fixtureQuote)) };

  it('ledger persists across boots through the store', async () => {
    const store = new MemStore();
    const file = '.local/durable-ledger.json';
    const a = await Ledger.loadDurable(store, file, STATE_KEYS.ledger);
    a.append('guardrail.emergency_stop', { at: 't' });
    a.append('deal.proposed', { id: 'd-1' });

    const b = await Ledger.loadDurable(store, file, STATE_KEYS.ledger);
    expect(b.all()).toHaveLength(2);
    expect(b.root()).toBe(a.root());
    expect(b.verify()).toBe(true);
  });

  it('subaccount snapshot survives restarts through the store', async () => {
    const store = new MemStore();
    const a = await VirtualSubaccount.create({
      market,
      store,
      seed: { balances: { BTC: '0' }, cash: '500' },
    });
    const receipt: Receipt = {
      orderId: 'm1',
      clientOrderId: 'c1',
      symbol: 'BTC',
      side: 'buy',
      quantity: '5950',
      priceMicro: '84000000000',
      feeMicro: '50000',
      status: 'filled',
      txRef: 'blk-0',
      at: new Date().toISOString(),
    };
    const [result] = await a.execute([receipt]);
    expect(result.status).toBe('filled');

    const b = await VirtualSubaccount.create({ market, store }); // fresh instance, no seed
    expect(b.cashReservedAtomic()).toBeLessThan(500_000_000n);
    const pos = await b.positions(['BTC']);
    expect(pos.balances.BTC).toBe('5950');
  });

  it('orchestrator restores deals and guardrail through the store', async () => {
    const store = new MemStore();
    const boot = async () => {
      const ledger = await Ledger.loadDurable(store, '.local/durable-oc-ledger.json', STATE_KEYS.ledger);
      const subaccount = await VirtualSubaccount.create({
        market,
        store,
        seed: { balances: { BTC: '0.0068', ETH: '0.05', SOL: '0.5' }, cash: '500' },
      });
      const broker = new Broker(subaccount, { workerId: 'broker-1', market });
      const auditor = new Auditor({ auditorId: 'aud-1', privateKey: AUDITOR_KEY });
      return Orchestrator.create({
        broker,
        auditor,
        subaccount,
        principalPrivateKey: PRINCIPAL_KEY,
        workerPayTo: privateKeyToAccount(AUDITOR_KEY).address,
        ledger,
        store,
        dealsFile: '.local/durable-oc-deals.json',
      });
    };

    const o1 = await boot();
    const deal = await o1.propose('rebalance', { BTC: 0.4, ETH: 0.3 });
    o1.stop();

    const o2 = await boot(); // restart
    expect(o2.list()).toHaveLength(1);
    expect(o2.get(deal.id)?.status).toBe('proposed');
    expect(o2.alive()).toBe(false);

    o2.resume();
    const o3 = await boot();
    expect(o3.alive()).toBe(true);
  });
});
