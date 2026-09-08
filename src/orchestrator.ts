import { privateKeyToAccount } from 'viem/accounts';
import type { Auditor } from './agent/auditor.js';
import type { Broker } from './agent/broker.js';
import { assertOrdersSortedStable, createDeal, toIntent, transition } from './domain/deal.js';
import { recoverSigner } from './domain/intent.js';
import { ASSET_UNIT } from './domain/money.js';
import { checkProposal, POLICY } from './domain/policy.js';
import type { Ledger } from './ledger.js';
import {
  buildPaymentRequired,
  encodePaymentPayload,
  encodePaymentRequired,
  LocalFacilitator,
  signAuthorization,
} from './money/rail.js';
import type { Deal, DealIntent, Receipt, Subaccount } from './types.js';

export interface OrchestratorOpts {
  broker: Broker;
  auditor: Auditor;
  subaccount: Subaccount;
  principalPrivateKey: `0x${string}`;
  workerPayTo: string; // an address the worker owns — fee lands here after verification
  ledger: Ledger;
}

export class Orchestrator {
  private readonly principal;
  private emergencyStop = false;
  private readonly deals = new Map<string, Deal>();
  private readonly facilitator: LocalFacilitator;

  constructor(private readonly opts: OrchestratorOpts) {
    this.principal = privateKeyToAccount(opts.principalPrivateKey);
    this.facilitator = new LocalFacilitator(this.principal.address);
  }

  get principalAddress() {
    return this.principal.address;
  }

  stop(): void {
    this.emergencyStop = true;
    this.opts.ledger.append('guardrail.emergency_stop', { at: new Date().toISOString() });
  }

  alive(): boolean {
    return !this.emergencyStop;
  }

  async propose(job: string, targets: { [symbol: string]: number }): Promise<Deal> {
    if (this.emergencyStop) throw new Error('emergency stop engaged');
    const proposal = await this.opts.broker.propose(job, targets);
    const failures = checkProposal(proposal);
    if (failures.length) {
      throw new Error(`policy rejected proposal: ${failures.map((f) => f.message).join('; ')}`);
    }
    const deal = createDeal(proposal);
    this.deals.set(deal.id, deal);
    this.opts.ledger.append('deal.proposed', {
      id: deal.id,
      job,
      orders: deal.orders,
      fee: deal.feeAtomic,
      policyHash: deal.policyHash,
    });
    return this.mutate(deal, 'proposed');
  }

  /** Principal signs the intent (EIP-712). Returns signature + recovered signer. */
  intentFor(deal: Deal, orderIndex = 0): DealIntent {
    return toIntent(deal, orderIndex, Math.floor(Date.now() / 1000) + 1800);
  }

  async approve(dealId: string, signature: `0x${string}`): Promise<Deal> {
    if (this.emergencyStop) throw new Error('emergency stop engaged');
    let deal = this.deals.get(dealId);
    if (!deal) throw new Error('unknown deal');

    // bind intent for each order to the signature (single signed intent wrapping the deal)
    const intent = this.intentFor(deal, 0);
    const signer = await recoverSigner(intent, signature);
    if (signer.toLowerCase() !== this.principal.address.toLowerCase()) {
      throw new Error(`intent signed by ${signer}, expected principal ${this.principal.address}`);
    }
    deal = { ...transition(deal, 'approved'), intent, signature, signer: signer.toLowerCase() };
    this.opts.ledger.append('deal.approved', {
      id: deal.id,
      intent,
      signer: signer.toLowerCase(),
      signature: `${signature.slice(0, 10)}…${signature.slice(-6)}`,
    });
    return this.mutate(deal, 'approved');
  }

  async execute(dealId: string): Promise<Deal> {
    if (this.emergencyStop) throw new Error('emergency stop engaged');
    let deal = this.deals.get(dealId);
    if (!deal) throw new Error('unknown deal');
    assertOrdersSortedStable(deal.orders); // sells first → the deal is funded as it fills
    deal = transition(deal, 'executing');

    const receipts: Receipt[] = [];
    for (let i = 0; i < deal.orders.length; i++) {
      const o = deal.orders[i]!;
      const filled: Receipt = {
        orderId: `MRK-${deal.id.slice(0, 8)}-${i + 1}`,
        clientOrderId: o.clientOrderId,
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity,
        priceMicro: o.limitPriceMicro,
        feeMicro: (
          (BigInt(o.quantity) * BigInt(o.limitPriceMicro) * BigInt(POLICY.maxTotalFeeBps)) /
          (ASSET_UNIT * 10_000n)
        ).toString(),
        status: 'filled',
        txRef: `blk-${0xdec + i}`,
        at: new Date().toISOString(),
      };
      receipts.push(filled);
    }
    const settled = await this.opts.subaccount.execute(receipts);
    deal = { ...deal, receipts: settled };
    this.opts.ledger.append('deal.executed', {
      id: deal.id,
      receipts: settled.map((r) => ({
        clientOrderId: r.clientOrderId,
        qty: r.quantity,
        price: r.priceMicro,
      })),
    });
    return this.mutate(deal, 'executed');
  }

  async audit(dealId: string): Promise<Deal> {
    let deal = this.deals.get(dealId);
    if (!deal) throw new Error('unknown deal');
    const verdict = await this.opts.auditor.audit(deal);
    deal = { ...deal, audit: verdict };
    this.opts.ledger.append('deal.audited', {
      id: deal.id,
      verdict: { passed: verdict.passed, checks: verdict.checks, signedBy: verdict.signedBy },
    });
    if (!verdict.passed) {
      return this.mutate(deal, 'failed');
    }
    return this.mutate(deal, 'verified');
  }

  /** x402: broker bills the fee; principal authorizes up-to; facilitator verifies BEFORE the work
   *  is considered paid, then settles — i.e. payment only releases once work verified. */
  async settle(dealId: string): Promise<Deal> {
    let deal = this.deals.get(dealId);
    if (!deal) throw new Error('unknown deal');
    if (deal.audit?.passed !== true) throw new Error('cannot settle an unverified deal');
    deal = transition(deal, 'settled');

    const fee = BigInt(deal.feeAtomic);
    const req = buildPaymentRequired({
      resource: `deal/${deal.id}/work`,
      payTo: this.workerPayTo(),
      maxAmountAtomic: fee,
      scheme: 'upto',
    });
    const { payload } = await signAuthorization({
      signerPrivateKey: this.principalPrivateKey(),
      req,
      amountAtomic: fee,
      resource: `deal/${deal.id}/work`,
    });

    const verified = await this.facilitator.verify(payload);
    if (!verified.ok) throw new Error(`x402 rejected: ${verified.reason}`);
    const settlement = await this.facilitator.settle(payload);

    const payment = {
      rail: 'x402' as const,
      scheme: 'upto' as const,
      network: req.accepts[0]!.network,
      amountAtomic: fee.toString(),
      payTo: this.workerPayTo(),
      signature: payload.payload.authorization,
      txHash: settlement.txHash ?? '',
      settledAt: new Date().toISOString(),
    };
    deal = { ...deal, payment };
    this.opts.ledger.append('deal.paid', {
      id: deal.id,
      payment: { scheme: 'upto', amount: fee.toString(), payTo: payment.payTo, txHash: payment.txHash },
      wire: {
        'PAYMENT-REQUIRED': encodePaymentRequired(req),
        'PAYMENT-SIGNATURE': encodePaymentPayload(payload),
      },
    });
    return this.mutate(deal, 'settled');
  }

  list(): Deal[] {
    return [...this.deals.values()];
  }

  get(id: string): Deal | undefined {
    return this.deals.get(id);
  }

  private workerPayTo(): string {
    return this.opts.workerPayTo;
  }

  private principalPrivateKey(): `0x${string}` {
    return this.opts.principalPrivateKey;
  }

  private mutate(deal: Deal, status: Deal['status']): Deal {
    const next = { ...deal, status, updatedAt: new Date().toISOString() };
    this.deals.set(next.id, next);
    return next;
  }
}
