import { toAssetDecimal, toDecimal } from '../domain/money.js';
import { addressOf, buildRuntime } from '../runtime.js';

const { market, broker, auditor, subaccount, orchestrator, ledger } = buildRuntime();

const YEL = (s: string) => `\x1b[33m${s}\x1b[0m`;
const GRN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

function hr() {
  console.log(DIM('─'.repeat(72)));
}

async function main() {
  console.log();
  console.log(GRN('  DEALFLOW — THE BROKER'));
  console.log(DIM('  Pay-per-outcome agents on Binance Agent OS. Work is a priced deal,'));
  console.log(DIM('  provably delivered, signed by you, paid only when the work checks out.'));
  hr();
  console.log(
    `  principal      ${addressOf((process.env.DEALFLOW_PRINCIPAL_KEY as `0x${string}`) ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')}`,
  );
  console.log(`  subaccount     ${subaccount.id}`);
  console.log(`  market         ${market.constructor.name}`);
  hr();

  // 1 — broker proposes a priced deal
  const job = 'rebalance to 20 / 40 / 40';
  const proposal = await broker.propose(job, { BTC: 0.2, ETH: 0.4, SOL: 0.4 });
  hr();
  console.log(YEL(`  STEP 1 · broker proposes`));
  console.log(`  job            ${proposal.job}`);
  console.log(`  before         ${JSON.stringify(proposal.beforeWeights)}`);
  console.log(`  target         ${JSON.stringify(proposal.targetWeights)}`);
  for (const line of proposal.summaryLines) console.log(`  ${line}`);
  console.log(DIM(`  policy hash    ${proposal.policyHash}  (${broker.workerId})`));
  hr();

  // 2 — deal created, held for signature
  const deal = await orchestrator.propose(job, { BTC: 0.2, ETH: 0.4, SOL: 0.4 });
  console.log(YEL(`  STEP 2 · deal pinned`));
  console.log(`  deal           ${deal.id}`);
  const exposureMicro = deal.orders.reduce(
    (a, o) => a + (BigInt(o.quantity) * BigInt(o.limitPriceMicro)) / 1_000_000n,
    0n,
  );
  console.log(
    `  status         ${deal.status} · ${deal.orders.length} legs · exposure $${toDecimal(exposureMicro)} · worker fee $${toDecimal(BigInt(deal.feeAtomic))}`,
  );
  hr();

  // 3 — principal signs the EIP-712 intent
  const { signIntent } = await import('../domain/intent.js');
  const intent = orchestrator.intentFor(deal, 0);
  const signature = await signIntent(
    intent,
    (process.env.DEALFLOW_PRINCIPAL_KEY as `0x${string}`) ??
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const approved = await orchestrator.approve(deal.id, signature as `0x${string}`);
  console.log(YEL(`  STEP 3 · principal signs intent (EIP-712)`));
  console.log(`  ${approved.intent?.job}`);
  console.log(`  signer         ${approved.signer} (recovered from signature)`);
  console.log(`  signature      ${signature.slice(0, 24)}…`);
  hr();

  // 4 — deterministic execution
  const executed = await orchestrator.execute(deal.id);
  console.log(YEL(`  STEP 4 · broker executes on scoped subaccount`));
  for (const r of executed.receipts) {
    console.log(
      `  fill           ${r.side} ${toAssetDecimal(BigInt(r.quantity))} ${r.symbol} @ $${toDecimal(BigInt(r.priceMicro))} · ${r.status} · ${r.clientOrderId}`,
    );
  }
  hr();

  // 5 — auditor reconciles, signs verdict
  const audited = await orchestrator.audit(deal.id);
  console.log(YEL(`  STEP 5 · auditor reconciles`));
  console.log(
    `  verdict        ${audited.audit?.passed ? GRN('PASS') : 'FAIL'} · ${audited.audit?.checks.map((c) => c.name).join(', ')}`,
  );
  console.log(`  signed by      ${audited.audit?.signedBy}`);
  hr();

  // 6 — x402 payment releases only now
  const settled = await orchestrator.settle(deal.id);
  console.log(YEL(`  STEP 6 · x402 settlement — payment releases on verified work`));
  console.log(
    `  rail           ${settled.payment?.rail} · scheme ${settled.payment?.scheme} · ${settled.payment?.network}`,
  );
  console.log(
    `  amount         $${toDecimal(BigInt(settled.payment?.amountAtomic ?? '0'))} → ${settled.payment?.payTo}`,
  );
  console.log(`  tx             ${settled.payment?.txHash}`);
  hr();

  // 7 — proof-of-work / evidence
  console.log(YEL(`  STEP 7 · evidence — everything signed, bounded, recorded`));
  console.log(`  ledger root    ${ledger.root()}`);
  console.log(`  chain intact   ${ledger.verify() ? GRN('VERIFIED') : 'BROKEN'}`);
  for (const e of ledger.all())
    console.log(DIM(`  ${String(e.seq).padStart(2, ' ')} ${e.kind.padEnd(20)} ${e.hash.slice(0, 16)}…`));
  hr();
  console.log(GRN('  DONE — the deal settled. The agent got paid for provable work.'));
  console.log(`  post-trade balances:`);
  const pos = await subaccount.positions(['BTC', 'ETH', 'SOL']);
  console.log(
    `  BTC ${toAssetDecimal(BigInt(pos.balances.BTC ?? '0'))} · ETH ${toAssetDecimal(BigInt(pos.balances.ETH ?? '0'))} · SOL ${toAssetDecimal(BigInt(pos.balances.SOL ?? '0'))} · cash $${toDecimal(BigInt(pos.cashAtomic))}`,
  );
  console.log();
  void auditor;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
