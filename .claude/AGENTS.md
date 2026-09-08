# dealflow — The Broker

Pay-per-outcome agents on Binance Agent OS. Work is a **priced deal**: the broker
proposes an exact, integer-math plan; the principal signs it (EIP-712); the broker
executes on a scoped subaccount; an independent auditor reconciles receipts
against the signed intent; only then does an x402 payment release the fee.

## Commands (run from repo root — this folder, `dealflow/`)

- `npm run demo` — full 7-step lifecycle in the terminal (propose → sign → execute → audit → settle → evidence → DONE).
- `npm test` — vitest unit suite (money, policy, ledger, subaccount, auditor, EIP-712 roundtrip).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run start` — Express API + dashboard on `http://127.0.0.1:4173`.
- `npm run dev` — server with watch. Rebuild UI first: `npm run ui:build` (Vite, output to `ui/dist`).
- `npm run ui:dev` — Vite dev server (5173, proxies `/api` to 4173).

Live market quotes: set `DEALFLOW_LIVE_MARKET=1` to hit Binance public REST;
otherwise a static fixture is used (`src/market.ts`) so the demo is offline-safe.

## Architecture (all integer math, no floats in money)

| Module | Responsibility |
|---|---|
| `src/domain/money.ts` | 6-decimal atomic types. `parseMicro`, `notionalOf`, `applyBps`, `quantityFromNotional`. |
| `src/domain/policy.ts` | Immutable `POLICY` object + hash. `checkProposal`/`checkOrder` guardrails. |
| `src/agent/broker.ts` | Goal → deal. Sizes orders against policy caps AND available dry powder (cash + proceeds − fees). |
| `src/domain/intent.ts` | EIP-712 typed signing of a deal. `signIntent`, `recoverSigner` (pure ecrecover). |
| `src/orchestrator.ts` | State machine: propose → approve → execute → audit → settle. Appends every step to the ledger. |
| `src/agent/auditor.ts` | Independently re-checks receipts vs signed intent before any payout. Verdict is itself signed. |
| `src/account.ts` | `VirtualSubaccount` — simulated fills with cash/asset checks. |
| `src/ledger.ts` | Append-only hash-chained evidence log; `verify()` fails on any rewrite. |
| `src/money/rail.ts` | x402 `upto` authorization objects (PAYMENT-REQUIRED / PAYMENT-SIGNATURE wire format). |
| `src/server.ts` + `ui/` | Express API + Vite/React dashboard driving the same lifecycle via HTTP. |

## The deal lifecycle (exactly 7 ledger events)

1. `deal.proposed` — broker builds a bounded plan; policy validates it.
2. `deal.approved` — principal signs the intent; signer recovered & verified.
3. `deal.executed` — broker fills on a scoped subaccount; receipts recorded.
4. `deal.audited` — auditor verdict (PASS/FAIL), signed by the auditor key.
5. `deal.paid` — only on PASS: x402 `upto` settlement releases the broker fee.
6. Ledger chain verified — tamper-evident root.
7. DONE.

**Invariant to preserve:** a broker must never propose a buy that the subaccount
cannot fund at the limit price (self-funding deals). The sizing logic in
`broker.propose` enforces this — if you touch it, rerun `npm run demo` and confirm
every leg fills and the audit passes.

## Money conventions (critical)

- All amounts are `bigint` in atomic units (1 USDC = 1_000_000). Asset quantities
  are also 6-decimal (`0.5 BTC` = `500000`). NEVER use floats for money.
- Prices are micro-dollars per unit in `OrderSpec.limitPriceMicro`.
- `applyBps` floors buys (price at-or-under cap) and ceils sells (price at-or-above floor).

## Keys

Demo keys are Hardhat/anvil accounts (see `src/runtime.ts`). They are demo-only —
in production these come from env: `DEALFLOW_PRINCIPAL_KEY`, `DEALFLOW_WORKER_KEY`,
`DEALFLOW_WORKER_PAY_TO`, `DEALFLOW_FEE_USDC`.

## Policy guardrails (src/domain/policy.ts)

- allowed symbols: BTC, ETH, SOL
- `maxNotionalAtomic` per deal = $1,000
- `maxSlippageBps` = 25, `maxTotalFeeBps` = 10
- `roundTrip` = true — a deal may not buy AND sell the same symbol
- `maxHoldingWeight` = 0.6 of NAV per asset
- every deal pins the policy hash, so a policy change after the fact is detected