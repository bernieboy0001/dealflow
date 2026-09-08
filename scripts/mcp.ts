#!/usr/bin/env tsx
/**
 * Minimal MCP stdio server (JSON-RPC 2.0 over newline-delimited stdin/stdout)
 * exposing dealflow as tools to any MCP-capable agent (Claude, etc.).
 *
 * Wire: each request/response/notification is one JSON object per line.
 * Reference: https://modelcontextprotocol.io (tools/list, tools/call, initialize)
 *
 * Run: `npx tsx scripts/mcp.ts`   (declare in .mcp.json / .claude/settings.json)
 */

import { buildRuntime } from '../src/runtime.js';
import { POLICY, policyHash, checkProposal } from '../src/domain/policy.js';
import { Ledger } from '../src/ledger.js';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------

let runtimeReady: ReturnType<typeof buildRuntime> | null = null;
function runtime() {
  if (!runtimeReady) runtimeReady = buildRuntime();
  return runtimeReady;
}

function usd(atomic: string): string {
  return `$${(Number(atomic) / 1e6).toFixed(2)}`;
}

// ---------------------------------------------------------------------------

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, { type: string; description?: string; [k: string]: unknown }>;
    additionalProperties?: boolean;
    required?: string[];
  };
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const TOOLS: Tool[] = [
  {
    name: 'policy',
    description: 'Show the immutable policy guardrails and its pinned hash.',
    inputSchema: { type: 'object', additionalProperties: false },
    run: async () => ({
      policy: {
        version: POLICY.version,
        allowedSymbols: POLICY.allowedSymbols,
        maxNotionalUsd: Number(POLICY.maxNotionalAtomic) / 1e6,
        maxFeeUsd: Number(POLICY.maxFeeAtomic) / 1e6,
        maxSlippageBps: POLICY.maxSlippageBps,
        maxTotalFeeBps: POLICY.maxTotalFeeBps,
        maxHoldingWeight: POLICY.maxHoldingWeight,
        noRoundTrips: POLICY.roundTrip,
      },
      policyHash: policyHash(),
    }),
  },
  {
    name: 'state',
    description: 'Broker state: principal address, worker id, subaccount positions, ledger root.',
    inputSchema: { type: 'object', additionalProperties: false },
    run: async () => {
      const r = runtime();
      const positions = await r.subaccount.positions([...POLICY.allowedSymbols]);
      return {
        principal: r.orchestrator.principalAddress,
        worker: r.broker.workerId,
        alive: r.orchestrator.alive(),
        subaccount: r.subaccount.id,
        cashUsd: usd(r.subaccount.cashReservedAtomic().toString()),
        positions: Object.fromEntries(Object.entries(positions.balances).map(([s, q]) => [s, q])),
        ledgerRoot: r.ledger.root(),
        ledgerVerified: r.ledger.verify(),
      };
    },
  },
  {
    name: 'propose_deal',
    description:
      'Dry-run a broker proposal for a job: target portfolio weights must sum <= 1.0 and each <= 0.6. Returns the priced, bounded order plan + policy verdict. Does not execute.',
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: 'human job description' },
        targets: {
          type: 'object',
          description: 'map of symbol -> target weight (0..0.6), e.g. {"BTC":0.5,"ETH":0.25,"SOL":0.25}',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['targets'],
      additionalProperties: false,
    },
    run: async (args) => {
      const targets = args.targets as Record<string, number>;
      if (!targets || typeof targets !== 'object') throw new Error('targets required');
      const r = runtime();
      const proposal = await r.broker.propose((args.job as string) ?? 'rebalance', targets);
      const failures = checkProposal(proposal);
      return {
        policyVerdict: failures.length ? { passed: false, failures } : { passed: true },
        worker: proposal.workerId,
        fee: usd(proposal.feeAtomic),
        notionalUsd: usd(proposal.maxNotionalAtomic),
        orders: proposal.orders.map((o) => ({
          symbol: o.symbol,
          side: o.side,
          quantity: o.quantity,
          limitPriceMicro: o.limitPriceMicro,
          limitUsd: usd(((BigInt(o.quantity) * BigInt(o.limitPriceMicro)) / 1_000_000n).toString()),
        })),
        summary: proposal.summaryLines,
      };
    },
  },
  {
    name: 'ledger_verify',
    description: 'Re-verify the append-only evidence hash chain. False means tampering detected.',
    inputSchema: { type: 'object', additionalProperties: false },
    run: async () => {
      const r = runtime();
      return { root: r.ledger.root(), verified: r.ledger.verify(), seq: r.ledger.seq };
    },
  },
];

// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.run(args ?? {});
}

// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false });

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }

  const id = req.id ?? null;
  const method = req.method ?? '';

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dealflow', version: '0.1.0' },
        },
      });
    } else if (method === 'notifications/initialized') {
      // ack only
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        },
      });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const result = await callTool(name ?? '', args ?? {});
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false },
      });
    } else {
      send({ jsonrpc: '2.0', id, result: {} });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } });
  }
});