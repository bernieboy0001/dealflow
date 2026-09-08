import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { portfolioWeights } from './account.js';
import { POLICY, policyHash } from './domain/policy.js';
import { buildRuntime, signDeal } from './runtime.js';
import { drainStore } from './storage.js';

/** Build the whole Dealflow API + dashboard app. Shared by the local server
 *  (src/server.ts) and the Vercel serverless function (api/index.ts). */
export async function createApp() {
  const app = express();
  app.use(express.json());

  let runtime = await buildRuntime();

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      ledger: runtime.ledger.root(),
      alive: runtime.orchestrator.alive(),
      durable: Boolean(
        process.env.DEALFLOW_KV_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
      ),
    });
  });

  app.get('/api/state', async (_req, res) => {
    try {
      const symbols = [...POLICY.allowedSymbols];
      const { navAtomic, weights, cashWeight, positions } = await portfolioWeights(
        runtime.subaccount,
        symbols,
      );
      res.json({
        principal: runtime.orchestrator.principalAddress,
        worker: runtime.broker.workerId,
        alive: runtime.orchestrator.alive(),
        at: new Date().toISOString(),
        policyHash: policyHash(),
        policy: {
          allowedSymbols: symbols,
          maxNotionalUsd: Number(POLICY.maxNotionalAtomic) / 1e6,
          maxSlippageBps: POLICY.maxSlippageBps,
          maxTotalFeeBps: POLICY.maxTotalFeeBps,
          maxFeeUsd: Number(POLICY.maxFeeAtomic) / 1e6,
          maxHoldingWeight: POLICY.maxHoldingWeight,
          brokerFeeUsd: Number(runtime.broker.feeMicro) / 1e6,
          roundTrip: POLICY.roundTrip,
        },
        portfolio: {
          navAtomic: navAtomic.toString(),
          cashAtomic: positions.cashAtomic,
          cashWeight,
          balances: positions.balances,
          valuesUsd: positions.valuesUsd,
          weights,
          fetchedAt: positions.fetchedAt,
        },
        ledgerRoot: runtime.ledger.root(),
        deals: runtime.orchestrator.list().map((d) => ({
          id: d.id,
          job: d.job,
          status: d.status,
          fee: d.feeAtomic,
          orders: d.orders.length,
          createdAt: d.createdAt,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/market', async (_req, res) => {
    try {
      const quotes = await runtime.market.quotes([...POLICY.allowedSymbols]);
      res.json({ quotes, at: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/propose', async (req, res) => {
    try {
      const { job, targets } = req.body as { job?: string; targets?: Record<string, number> };
      if (!targets) throw new Error('missing targets');
      const deal = await runtime.orchestrator.propose(job ?? 'rebalance', targets);
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
      const deal = await runtime.orchestrator.approve(dealId, signature as `0x${string}`);
      res.json({ deal });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post('/api/execute', async (req, res) => {
    try {
      const { dealId } = req.body as { dealId: string };
      let deal = await runtime.orchestrator.execute(dealId);
      deal = await runtime.orchestrator.audit(dealId);
      res.json({ deal });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post('/api/settle', async (req, res) => {
    try {
      const { dealId } = req.body as { dealId: string };
      const deal = await runtime.orchestrator.settle(dealId);
      res.json({ deal });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post('/api/stop', (_req, res) => {
    runtime.orchestrator.stop();
    res.json({ alive: runtime.orchestrator.alive() });
  });

  app.post('/api/resume', (_req, res) => {
    runtime.orchestrator.resume();
    res.json({ alive: runtime.orchestrator.alive() });
  });

  /** Reboot the broker runtime from durable state (ledger, account, deals).
   *  Behind a stop this is the "start fresh against the evidence chain" reset. */
  app.post('/api/restart', async (_req, res) => {
    try {
      await drainStore(); // make sure pending durable writes landed before reload
      runtime = await buildRuntime();
      res.json({
        ok: true,
        alive: runtime.orchestrator.alive(),
        ledgerRoot: runtime.ledger.root(),
        deals: runtime.orchestrator.list().length,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/deals/:id', (req, res) => {
    const deal = runtime.orchestrator.get(req.params.id);
    if (!deal) return res.status(404).json({ error: 'not found' });
    res.json({ deal });
  });

  app.get('/api/ledger', (_req, res) => {
    res.json({
      root: runtime.ledger.root(),
      verified: runtime.ledger.verify(),
      entries: runtime.ledger.all().map((e) => ({
        seq: e.seq,
        kind: e.kind,
        payload: e.payload,
        prevHash: e.prevHash,
        hash: e.hash,
        at: e.at,
      })),
    });
  });

  // Local/single-process serving: the static dashboard lives at ui/dist.
  // On Vercel the static tier serves this instead; both work through the same app.
  const uiDist = join(process.cwd(), 'ui', 'dist');
  if (existsSync(join(uiDist, 'index.html'))) {
    app.use(express.static(uiDist));
    app.get('/{*splat}', (_req, res) => res.sendFile(join(uiDist, 'index.html')));
  }

  return app;
}
