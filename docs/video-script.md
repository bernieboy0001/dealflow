# DEALFLOW — "The Broker"
### 10-minute video script (build log / dev walkthrough)

**Format:** screen-demo with live terminal, terse narration. Terminal font ~14-16px,
dark theme, no music bed (or quiet pulse track). Total ~10 min including the full
`npm run demo` run and a dashboard drive.

---

## 00:00 — Cold open (0:30)

**Screen:** terminal, `npm run demo` already scrolled to the last few lines — the
DONE block with the green `PASS · all`, x402 tx hash, and ledger chain.

> "An agent that promises to rebalance your portfolio gets paid before the work is
> audited. It's a *well-behaved* agent, but you're trusting it. Not good enough.
>
> This is dealflow — *The Broker* for Binance Agent OS. Work becomes a priced deal:
> provably delivered, signed by you, and paid only when an independent auditor says
> the work checks out. Every step lands in a tamper-evident ledger. One command,
> seven steps, done."

**Clears screen.**

---

## 00:30 — What you're building (0:40)

**Screen:** repo tree (`tree /f` or `Get-ChildItem -Recurse`), slow pan.

> "Today I built, from scratch, the pieces that make that half-second claim real:
>
> - a **broker** that turns a goal into an exact, integer-priced, policy-bounded deal
> - an **auditor** that re-verifies execution before a single dollar moves
> - an **x402 rail** so the fee actually settles on-chain only after the verdict
> - a **hash-chained ledger** that makes the whole story tamper-evident
> - a little **React dashboard** so you can watch the deal walk the machine
> - and an **MCP server** so agents can inspect and propose deals themselves"

**Note:** these are the 6 sections; show headings as you go.

---

## 01:10 — Guardrail #1: money is integers (1:00)

**Screen:** `src/domain/money.ts` open, cursor on `parseMicro` / `quantityFromNotional`.

> "Before any deal logic: money is a `bigint`, six decimals, everywhere. `applyBps`
> floors buys and ceils sells so the broker can never cross a cap by a rounding
> error. Quantities come from `quantityFromNotional` — integer math, floored, so
> cost can never exceed budget."

**Type `npm test -- money`** (or just `npm test` once at the end — keep this one short).

> "The invariant every other piece leans on: price in, quantity out, no floats."

---

## 02:10 — Guardrail #2: the policy is pinned (0:50)

**Screen:** `src/domain/policy.ts`, highlight `POLICY` and `policyHash`.

> "Symbols, notional cap, slippage, fee band, no round-trips — one object, hashed.
> Every deal pins that hash into its signed intent. The auditor re-hashes at
> payment time, so a policy that changed under the deal gets caught."

---

## 03:00 — The broker: a goal, turned into a priced deal (1:30)

**Screen:** `src/agent/broker.ts`, scroll to `propose()`.

> "Here's the interesting part. 'Rebalance to 20/40/40' in, and out comes a deal:
> exact quantities, limit prices, a fee, an expiry — all derived by the broker.
>
> And the sizing law: a deal must be **self-funding**. The broker computes buys
> against cash-on-hand *plus* proceeds from this deal's sells, *minus* exchange
> fees. If it can't fund a leg at the limit price, it scales the leg down — not
> silently, but into a smaller, still-bounded deal."

**On-screen test:** show `npm run demo` Step 1 briefly (fast) to prove a deal
that just *fits*: each buy is ≤ dry powder.

> "No broker is richer than the wallet it trades. The deal respects that at
> proposal time, so the exchange never has to say 'rejected.'"

---

## 04:30 — The deal: must be signed (1:00)

**Screen:** `src/domain/intent.ts`, `DEALFLOW_DOMAIN`, `signIntent`, `recoverSigner`.

> "A deal is only a deal when the principal signs it — full EIP-712 typed data,
> one intent per deal, hashing in the exact orders, limits, fee, policy hash, and
> a deadline. Signing is done with viem; recovery is pure ecrecover, no RPC.
> Wrong signer? The orchestrator won't even start executing."

---

## 05:30 — Execute on a scoped subaccount (1:00)

**Screen:** `src/account.ts` — `VirtualSubaccount.execute`, the cash/asset checks.

> "Execution happens on a *subaccount*. That's the Agent OS story in miniature:
> the agent never touches the principal wallet — it moves money inside a scoped
> box. Fills check available cash and available asset before they commit; a leg
> that can't fill becomes a rejected receipt, and a rejected receipt means the
> auditor fails the deal — no payout."

---

## 06:30 — The auditor: pay nothing until it checks out (1:20)

**Screen:** `src/agent/auditor.ts`, the check list (receipt coverage, price at-or-
under limit, exact quantity, fee bound, idempotency, policy pin). Then `npm run demo`
Step 4→5 full-speed.

> "The auditor re-runs the whole truth, deterministically, before payment:
> every order produced precisely one filled receipt; execution respected the
> signed limits; quantities match; fees stayed inside the band. The verdict is
> a PASS or FAIL — and the verdict itself is signed as evidence.
>
> Structurally: in a correct run you see `verdict PASS · all`. Tamper with a single
> field — say, a fill above the limit price — and the same code path flips to FAIL
> and the deal dies at `failed`, unpayable."

---

## 07:50 — x402: payment only after the verdict (1:20)

**Screen:** `src/money/rail.ts`, then `npm run demo` Step 6 — the x402 block.

> "Now the payout: x402, `upto` scheme. The principal authorizes a capped payment;
> the facilitator checks the authorization *after* the audit verdict, then settles.
> I generate the `PAYMENT-REQUIRED` and `PAYMENT-SIGNATURE` wire blobs, sign the
> authorization, and record the settlement tx hash into the ledger next to the
> verdict. Payment is structurally downstream of PASS — there's no other path to
> `settled`."

---

## 09:10 — Evidence: the ledger, and the MCP endpoint (0:50)

**Screen:** `npm run demo` Step 7 — `5 deal.paid`, `chain intact VERIFIED`.
Then `scripts/mcp.ts` + a quick `npx tsx scripts/mcp.ts` tools/call.

> "Every step is append-only, hash-chained, and `verify()` re-derives the whole
> chain — one rewritten entry and the root stops matching. The same domain is
> exposed over MCP: an agent can call `propose_deal` to see a policy-verified,
> self-funding plan, `ledger_verify` to prove the chain, `state` to read positions."

---

## 10:00 — Close (0:20)

**Screen:** dashboard `http://127.0.0.1:4173` — deal row after settle: PASS audit,
paid via x402; ledger panel shows 5 entries, verified badge green.

> "Broker pays out only on provable work. That's the whole thesis: give agents a
> wallet, a market, a policy, and a way to prove what they did — and the machine
> settles the invoice.
>
> Dealflow is open on GitHub at the usual place. `npm install`, `npm run demo`,
> watch it settle. That's The Broker. Thanks for watching."

**Fade.**

---

## Production notes

- Every `npm run demo` run is deterministic offline (fixture prices). Re-run
  quickly to trim takes; blank-scroll between sections to hide teletype noise.
- If recording, force ANSI colors via `--ansi` and a TTY width of 100+ so the
  `────────────┐` headers stay aligned. (On Windows set $env:FORCE_COLOR=1.)
- The dashboard drive in the close can be replaced with a lightweight replay of
  the settle API call if screen time is tight.
- Sample timestamps assume a slow, deliberate read; tighten narration to keep
  under 10:00 by trimming the auditor and rail sections.