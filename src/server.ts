import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRuntime, signDeal } from './runtime.js';
import { policyHash, POLICY } from './domain/policy.js';

const app = express();
app.use(express.json());

const runtime = buildRuntime();
const { orchestrator, ledger } = runtime;

app.get('/health', (_req, res) => {
  res.json({ ok: true, ledger: ledger.root(), alive: orchestrator.alive() });
});

app.get('/api/state', (_req, res) => {
  res.json({
    principal: orchestrator.principalAddress,
    worker: runtime.broker.workerId,
    alive: orchestrator.alive(),
    policyHash: policyHash(),
    policy: {
      allowedSymbols: POLICY.allowedSymbols,
      maxNotionalUsd: Number(POLICY.maxNotionalAtomic) / 1e6,
      maxSlippageBps: POLICY.maxSlippageBps,
      maxTotalFeeBps: POLICY.maxTotalFeeBps,
      roundTrip: POLICY.roundTrip,
    },
    ledgerRoot: ledger.root(),
    deals: orchestrator.list().map((d) => ({ id: d.id, job: d.job, status: d.status, fee: d.feeAtomic, orders: d.orders.length, createdAt: d.createdAt })),
  });
});

app.post('/api/propose', async (req, res) => {
  try {
    const { job, targets } = req.body as { job?: string; targets?: Record<string, number> };
    if (!targets) throw new Error('missing targets');
    const deal = await orchestrator.propose(job ?? 'rebalance', targets);
    res.json({ deal });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** The "human approves": signs the EIP-712 intent with the principal key,
 *  which is exactly the step a wallet injection would perform in the UI. */
app.post('/api/approve', async (req, res) => {
  try {
    const { dealId } = req.body as { dealId: string };
    const signature = await signDeal(dealId, runtime);
    const deal = await orchestrator.approve(dealId, signature as `0x${string}`);
    res.json({ deal });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/execute', async (req, res) => {
  try {
    const { dealId } = req.body as { dealId: string };
    let deal = await orchestrator.execute(dealId);
    deal = await orchestrator.audit(dealId);
    res.json({ deal });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/settle', async (req, res) => {
  try {
    const { dealId } = req.body as { dealId: string };
    const deal = await orchestrator.settle(dealId);
    res.json({ deal });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/stop', (_req, res) => {
  orchestrator.stop();
  res.json({ alive: orchestrator.alive() });
});

app.get('/api/deals/:id', (req, res) => {
  const deal = orchestrator.get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'not found' });
  res.json({ deal });
});

app.get('/api/ledger', (_req, res) => {
  res.json({
    root: ledger.root(),
    verified: ledger.verify(),
    entries: ledger.all().map((e) => ({ seq: e.seq, kind: e.kind, payload: e.payload, prevHash: e.prevHash, hash: e.hash, at: e.at })),
  });
});

const uiDist = join(process.cwd(), 'ui', 'dist');
if (existsSync(join(uiDist, 'index.html'))) {
  app.use(express.static(uiDist));
  app.get('/{*splat}', (_req, res) => res.sendFile(join(uiDist, 'index.html')));
}

const port = Number(process.env.PORT ?? 4173);
app.listen(port, '127.0.0.1', () => {
  console.log(`[dealflow] Principal: ${orchestrator.principalAddress}`);
  console.log(`[dealflow] The Broker — pay-per-outcome agent on Agent OS`);
  console.log(`[dealflow] dashboard: http://127.0.0.1:${port}`);
});