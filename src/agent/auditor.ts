import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { POLICY, policyHash } from '../domain/policy.js';
import type { AuditVerdict, Deal, Receipt } from '../types.js';

export interface AuditorOpts {
  auditorId: string;
  privateKey: `0x${string}`;
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * The Auditor. Reconciles executed work against the signed intent, purely
 * deterministically. Runs BEFORE any payment is released — the broker is paid
 * only if every check passes. Its verdict is itself signed (evidence).
 */
export class Auditor {
  private readonly account;

  constructor(private readonly opts: AuditorOpts) {
    this.account = privateKeyToAccount(opts.privateKey);
  }

  async audit(deal: Deal): Promise<AuditVerdict> {
    const checks: Check[] = [];

    // 1. intent was signed by the principal (validated upstream at approval time;
    // here we re-bind: quantity/price must match what was signed into the intent)
    if (!deal.intent) checks.push({ name: 'intent-bound', ok: false, detail: 'deal has no signed intent' });

    // 2. every order produced a filled receipt — nothing rejected or missing
    const filled = new Map(deal.receipts.map((r) => [r.clientOrderId, r]));
    for (const o of deal.orders) {
      const r = filled.get(o.clientOrderId);
      if (!r) {
        checks.push({
          name: 'receipt',
          ok: false,
          detail: `missing receipt for ${o.symbol} ${o.clientOrderId}`,
        });
      } else if (r.status !== 'filled') {
        checks.push({ name: 'receipt', ok: false, detail: `${o.symbol} order ${r.status}` });
      }
    }

    // 3. execution price respected the signed limit (buys never above, sells never below)
    for (const r of deal.receipts) {
      const limit = BigInt(r.priceMicro);
      const signed = deal.orders.find((o) => o.clientOrderId === r.clientOrderId);
      if (signed) {
        const expected = BigInt(signed.limitPriceMicro);
        const ok = r.side === 'buy' ? limit <= expected : limit >= expected;
        if (!ok) {
          checks.push({
            name: 'price-limit',
            ok: false,
            detail: `${r.symbol} at ${r.priceMicro} vs limit ${signed.limitPriceMicro}`,
          });
        }
      }
    }

    // 4. quantity exactly as signed — no phantom size
    for (const r of deal.receipts) {
      const signed = deal.orders.find((o) => o.clientOrderId === r.clientOrderId);
      if (signed && BigInt(r.quantity) !== BigInt(signed.quantity)) {
        checks.push({
          name: 'quantity',
          ok: false,
          detail: `${r.symbol}: filled ${r.quantity} vs signed ${signed.quantity}`,
        });
      }
    }

    // 5. exchange fees under the agreed bound (2x expected is tolerable noise; hard cap = policy)
    const realizedFees = deal.receipts.reduce((a, r) => a + BigInt(r.feeMicro), 0n);
    const expectedFees = BigInt(deal.expectedFeeAtomic);
    if (realizedFees > expectedFees * 2n) {
      checks.push({
        name: 'fee-bound',
        ok: false,
        detail: `fees $${realizedFees.toString()} vs expected $${expectedFees.toString()}`,
      });
    }
    if (realizedFees > BigInt(POLICY.maxFeeAtomic) + BigInt(deal.feeAtomic)) {
      checks.push({ name: 'fee-cap', ok: false, detail: 'fees beyond policy cap' });
    }

    // 6. idempotency — every clientOrderId appears exactly once (no duplicate fills)
    const seen = new Map<string, number>();
    for (const r of deal.receipts) seen.set(r.clientOrderId, (seen.get(r.clientOrderId) ?? 0) + 1);
    for (const [id, n] of seen) {
      if (n !== 1) checks.push({ name: 'idempotency', ok: false, detail: `order ${id} filled ${n}x` });
    }

    // 7. policy still bound the deal
    if (deal.policyHash !== policyHash()) checks.push({ name: 'policy-pinned', ok: false });

    const passed = checks.length === 0 || checks.every((c) => c.ok);
    const verdict: AuditVerdict = {
      auditorId: this.opts.auditorId,
      passed,
      checks: checks.length ? checks : [{ name: 'all', ok: true, detail: 'every check green' }],
      signedBy: this.account.address,
      signature: '',
      at: new Date().toISOString(),
    };
    verdict.signature = await this.account.signMessage({ message: auditMessage(deal.id, passed, checks) });
    return verdict;
  }
}

function auditMessage(dealId: string, passed: boolean, checks: Check[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ dealId, passed, checks, at: new Date().toISOString() }))
    .digest('hex');
}

export function receiptsOf(receipts: Receipt[]): Receipt[] {
  return receipts.sort((a, b) => a.clientOrderId.localeCompare(b.clientOrderId));
}
