# dealflow — The Broker

**Pay-per-outcome agents on Binance Agent OS.** Work is a priced deal, provably
delivered, signed by you, paid only when the work checks out.

Instead of trusting an agent's promise ("I rebalanced your portfolio"), the broker
turns a goal into an **exact, signed, bounded deal**:

1. **Propose** — "rebalance to 20/40/40" becomes 3 integer-priced limit orders + a fee.
2. **Sign** — the principal approves the intent with an EIP-712 signature.
3. **Execute** — the broker fills against a scoped subaccount. No hidden legs.
4. **Audit** — an independent auditor reconciles every receipt against the signed intent.
5. **Pay** — and only then does an x402 payment release the fee to the worker.

Every step is written to an append-only, tamper-evident ledger.

```
07:23:04  STEP 5 · auditor reconciles
          verdict        PASS · all
          signed by      0x3C44…B3BC
          STEP 6 · x402 settlement — payment releases on verified work
          amount         $12.500000 → 0x3C44…B3BC
          tx             0x1384…fd975
          DONE — the deal settled. The agent got paid for provable work.
```

## Why it works

- **No float math, ever.** All money is `bigint` in 6-decimal atomic units. Orders
  are derived with integer math (`src/domain/money.ts`).
- **Deals are self-funding.** The broker sizes every buy against available dry
  powder — cash plus sell proceeds minus exchange fees — so a signed deal can
  actually fill at its limit price, or the execution fails loudly (and unpayable).
- **Order is canonical.** `sortDealOrders` orders sells first, then buys, then by
  `symbol:quantity:limitPriceMicro`, and `assertOrdersSortedStable` gates execution
  on it — so a signed deal always fills in the sequence that funds itself.
- **Guardrails are pinned, not promised.** Policy (symbols, notional cap, slippage,
  fee band, no round-trips) is hashed into every deal; the auditor re-checks it
  against the current hash at settlement time.
- **Payment only after verification.** The auditor's PASS gate sits before the
  x402 `upto` settlement in the state machine. There is no code path that pays
  first.

## Getting started

```bash
npm install
npm run demo          # full lifecycle in the terminal, offline-safe
npm test              # 30 unit tests — money, policy, ledger, audit, signatures
npm run typecheck
npm run lint          # biome check . — style, correctness, unused imports
npm run start         # Express API + dashboard → http://127.0.0.1:4173
```

For the dashboard, rebuild the UI once (then `npm run start` serves it):

```bash
npm run ui:build      # Vite → ui/dist, served by the Express server
npm run ui:dev        # or live dev on :5173 (proxies /api → :4173)
npm run typecheck:ui  # tsc for the ui/ tree
```

The dashboard has two tabs: a live **Dashboard** (portfolio, deals, evidence ledger)
and a full built-in **Docs** tab covering the lifecycle, policy, money model,
ledger, setup, architecture, API and MCP reference.

The demo and server use a market **fixture** so everything runs offline. For live
Binance quotes set `DEALFLOW_LIVE_MARKET=1`.

## The state machine

```
proposing ─> proposed ─> approved ─> executing ─> executed ─> verified ─> settled
                            │                          │
                            └──── rejected / cancelled ─┘
                                                          └─> failed  (audit FAIL — no payout)
```

Long-lived events: `deal.proposed`, `deal.approved`, `deal.executed`,
`deal.audited`, `deal.paid` — each linked by SHA-256 to its predecessor.

## Repository layout

```
src/domain/     money, policy, intent (EIP-712), deal state machine
src/agent/      broker (plans) + auditor (verifies)
src/orchestrator.ts   the deal lifecycle, ledger writes
src/account.ts        virtual scoped subaccount with fill simulation
src/money/rail.ts     x402 PAYMENT-REQUIRED / PAYMENT-SIGNATURE wire format
src/ledger.ts         append-only hash chain
src/server.ts         Express API
ui/                   Vite + React dashboard
scripts/mcp.ts        stdio MCP server exposing dealflow tools to agents
```

## Agent tools (MCP)

The repo self-hosts a small MCP server so agents can inspect policy, portfolio
state, dry-run proposals, and verify the ledger over stdio:

```json
// .claude/settings.json (declared here already)
{ "mcpServers": { "dealflow": { "command": "npx", "args": ["tsx", "scripts/mcp.ts"] } } }
```

Tools: `policy`, `state`, `propose_deal` (dry-run, policy-verified), `ledger_verify`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `DEALFLOW_LIVE_MARKET` | unset | `1` = live Binance REST, else fixture |
| `DEALFLOW_PRINCIPAL_KEY` | demo anvil key | key that signs deal intents |
| `DEALFLOW_WORKER_KEY` | demo anvil key | auditor key + default fee destination |
| `DEALFLOW_WORKER_PAY_TO` | worker key address | address that receives the fee via x402 |
| `DEALFLOW_FEE_USDC` | `12.50` | broker fee per deal |

Demo keys are Hardhat/anvil accounts. **Not for production.**

## API

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness + ledger root |
| `GET /api/state` | principal, worker, policy, portfolio (positions/NAV/weights), deals |
| `GET /api/market` | live/fixture quotes for the allowed symbols |
| `POST /api/propose` | `{job, targets}` → new deal |
| `POST /api/approve` | `{dealId}` → signs intent (as the principal) |
| `POST /api/execute` | `{dealId}` → fills + audits |
| `POST /api/settle` | `{dealId}` → x402 payout (only when audit passed) |
| `POST /api/stop` | emergency stop — broker rejects new proposals; persisted on the ledger, so it survives restarts |
| `POST /api/resume` | lifts the emergency stop; recovery recorded on the ledger |
| `GET /api/deals/:id` | single deal detail |
| `GET /api/ledger` | full evidence chain + verification |

## Testing

Vitest, 30 cases covering: money parsing/flooring/rounding, policy cap rejection,
ledger chain tamper-evidence, subaccount fill/rejection logic, auditor pass/fail
paths, and EIP-712 sign/recover roundtrip.

## The punchline

An agent that does provable work on a scoped subaccount, for a price you sign,
paid by a machine that verifies first — that's the primitive Agent OS flows are
made of. This is the broker that makes it a *deal* instead of a promise.