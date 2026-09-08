import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

type ToastTone = 'good' | 'bad';

interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

type Side = 'buy' | 'sell';
type DealStatus =
  | 'proposing'
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'verified'
  | 'settled'
  | 'rejected'
  | 'cancelled'
  | 'failed';

interface OrderSpec {
  symbol: string;
  side: Side;
  quantity: string;
  limitPriceMicro: string;
  maxSlippageBps: number;
  clientOrderId: string;
}

interface Deal {
  id: string;
  job: string;
  status: DealStatus;
  feeAtomic: string;
  orders: OrderSpec[];
  summaryLines: string[];
  targetWeights: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  receipts?: { clientOrderId: string; symbol: string; side: Side; status: string; priceMicro: string }[];
  audit?: { passed: boolean; checks: { name: string; ok: boolean; detail?: string }[]; signedBy: string };
  payment?: { rail: string; txHash: string; payTo: string };
}

interface Portfolio {
  navAtomic: string;
  cashAtomic: string;
  cashWeight: string;
  balances: Record<string, string>;
  valuesUsd: Record<string, string>;
  weights: Record<string, string>;
  fetchedAt: string;
}

interface PolicyView {
  allowedSymbols: string[];
  maxNotionalUsd: number;
  maxSlippageBps: number;
  maxTotalFeeBps: number;
  maxFeeUsd: number;
  maxHoldingWeight: number;
  brokerFeeUsd: number;
  roundTrip: boolean;
}

interface State {
  principal: string;
  worker: string;
  alive: boolean;
  at: string;
  policyHash: string;
  policy: PolicyView;
  portfolio: Portfolio;
  ledgerRoot: string;
  deals: { id: string; job: string; status: DealStatus; fee: string; orders: number; createdAt: string }[];
}

interface LedgerView {
  root: string;
  verified: boolean;
  entries: { seq: number; kind: string; payload: unknown; prevHash: string; hash: string; at: string }[];
}

const MICRO = 1e6;
const SYMBOLS = ['BTC', 'ETH', 'SOL'] as const;
const DEFAULT_TARGETS: Record<(typeof SYMBOLS)[number], number> = { BTC: 0.2, ETH: 0.4, SOL: 0.4 };

const STATUS: Record<DealStatus, { label: string; tone: string }> = {
  proposing: { label: 'Proposing', tone: 'gray' },
  proposed: { label: 'Awaiting signature', tone: 'blue' },
  approved: { label: 'Signed — ready', tone: 'violet' },
  executing: { label: 'Executing', tone: 'amber' },
  executed: { label: 'Executed', tone: 'green' },
  verified: { label: 'Verified', tone: 'green' },
  settled: { label: 'Paid', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
  failed: { label: 'Failed', tone: 'red' },
};

const NEXT_ACTION: Record<DealStatus, { label: string; endpoint: string } | null> = {
  proposing: null,
  proposed: { label: 'Sign intent', endpoint: 'approve' },
  approved: { label: 'Execute + audit', endpoint: 'execute' },
  executing: null,
  executed: null,
  verified: { label: 'Release fee (x402)', endpoint: 'settle' },
  settled: null,
  rejected: null,
  cancelled: null,
  failed: null,
};

const GUIDE: { title: string; short: string; body: string }[] = [
  {
    title: 'Propose',
    short: 'Broker prices the goal into a bounded plan',
    body: 'The broker reads the subaccount, prices the move, and writes a deterministic plan: legs, limits, the worker fee, and the pinned policy hash. Nothing is signed yet, nothing moves.',
  },
  {
    title: 'Pin policy',
    short: 'The rules the deal ran under',
    body: 'The proposal carries the hash of the standing deal policy. If the rules ever change, old proposals no longer match — you always know exactly which rules a deal was bound by.',
  },
  {
    title: 'Sign intent',
    short: 'You authorize with EIP-712',
    body: 'You sign the EIP-712 intent with the principal key. Execution is gated on a signature that recovers to your address. No signature, no trade.',
  },
  {
    title: 'Execute',
    short: 'Fills happen sells-first',
    body: 'Orders run in canonical order — sells first, then buys — so the deal funds itself from cash plus sale proceeds. Every fill is captured as a receipt.',
  },
  {
    title: 'Audit',
    short: 'Independent reconciliation',
    body: 'An independent auditor re-checks every leg against the signed intent and the policy, then signs the verdict. A signed PASS is what unlocks payment.',
  },
  {
    title: 'Settle',
    short: 'Pay only on verified work',
    body: 'An x402 \u201cup-to\u201d authorization releases the worker fee to the worker’s address — only after the audit PASS. Pay-per-outcome, in code.',
  },
  {
    title: 'Seal ledger',
    short: 'Evidence is written forever',
    body: 'Every event (propose, sign, fills, verdict, payment) is appended to an append-only hash chain. The UI shows the root it verifies right now.',
  },
];

/* ------------------------------------------------------------------ docs */

type DocBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'note'; text: string }
  | { kind: 'flow' };

interface DocSection {
  id: string;
  title: string;
  blurb: string;
  blocks: DocBlock[];
}

const DOCS: DocSection[] = [
  {
    id: 'overview',
    title: 'Overview',
    blurb: 'What this is and why it exists.',
    blocks: [
      {
        kind: 'p',
        text: 'dealflow is "The Broker" — a reference implementation of a pay-per-outcome agent on Binance Agent OS. It answers one problem: when an AI agent claims to have done work ("I rebalanced your portfolio"), how do you pay it only when that is true, without trusting its word?',
      },
      {
        kind: 'p',
        text: 'Instead of trusting a promise, the broker turns a goal into an exact, priced, signed deal:',
      },
      {
        kind: 'ol',
        items: [
          'Propose — "rebalance to 30/30/30" becomes concrete limit orders plus a fee.',
          'Sign — you approve the deal with an EIP-712 signature.',
          'Execute — the broker fills on a scoped subaccount, sells first.',
          'Audit — an independent auditor reconciles every receipt against the signed intent.',
          'Pay — and only then does an x402 payment release the fee.',
        ],
      },
      {
        kind: 'note',
        text: 'The core primitive: work that an agent can prove, priced as a deal, paid by a machine that verifies first. Everything else in the UI is instrumentation to watch that happen.',
      },
      { kind: 'h', text: 'The dashboard' },
      {
        kind: 'p',
        text: 'The Dashboard tab is a live window into one running broker: the subaccount it trades, the deals it has proposed, the evidence ledger behind them, and the standing policy those deals must satisfy. The Docs tab you are reading is the full reference.',
      },
    ],
  },
  {
    id: 'lifecycle',
    title: 'How a deal gets paid',
    blurb: 'The 7-step lifecycle, end to end.',
    blocks: [
      { kind: 'flow' },
      {
        kind: 'note',
        text: 'Nothing is automatic. Every transition is a separate, signed event, and each one is written to the evidence ledger before the next may happen.',
      },
      { kind: 'h', text: 'Why sells run first' },
      {
        kind: 'p',
        text: 'A deal must be self-funding. The broker sizes every buy from your available dry powder (cash, plus the proceeds the sells in this same deal will free up, minus exchange fees). To keep that guarantee honest, orders execute in a canonical order — sells before buys, ties broken by symbol, quantity, then limit price. The signing step binds that exact sequence, and execution refuses to run out of order.',
      },
    ],
  },
  {
    id: 'policy',
    title: 'Policy & guardrails',
    blurb: 'The rules every deal must satisfy.',
    blocks: [
      {
        kind: 'p',
        text: 'A standing POLICY object caps what the broker may propose. Rules are checked at proposal time (checkProposal) and again by the auditor at verification time — plus every deal carries a hash of the policy it was built under, so a rule change after the fact is detectable.',
      },
      {
        kind: 'table',
        head: ['Rule', 'Cap', 'What it means'],
        rows: [
          ['Max notional / deal', '$1,000', 'buy-side notional of one deal cannot exceed this'],
          ['Max slippage', '25 bps', 'limit price is banded ±25bps off the quoted bid/ask'],
          ['Exchange fee budget', '10 bps', 'fees are reserved per leg when sizing buys'],
          ['Max worker fee', '$50', 'the broker cannot price a deal above this'],
          ['Max holding weight', '60%', 'no single asset target may exceed 60% of NAV'],
          ['Broker fee (demo)', '$12.50', 'the actual price of a deal, paid via x402 on audit PASS'],
          ['Round-trips', 'blocked', 'a deal may not buy and sell the same symbol'],
        ],
      },
      {
        kind: 'note',
        text: 'The policy hash shown on the dashboard (policyHash) is over these exact rules. If the code changes them, every historical deal still names the old hash — the auditor can tell which ruleset a deal actually ran under.',
      },
    ],
  },
  {
    id: 'money',
    title: 'Money model',
    blurb: 'Integer math, atomic units, no floats.',
    blocks: [
      {
        kind: 'p',
        text: 'Every amount in dealflow is a bigint in atomic units: 1 USDC = 1,000,000. Asset quantities are at the same 6-decimal scale (0.85 BTC = 850000). Floating point is never used for money, so rounding cannot drift or produce dealless surprises.',
      },
      {
        kind: 'ul',
        items: [
          'Prices are micro-dollars per unit: limitPriceMicro.',
          'Buy limits floor at the cap (applyBps floors buys) — conservative for you.',
          'Sell limits ceil at the floor — you keep the spread.',
          'Notional and fees are derived with integer division, always in the buyer’s favor.',
        ],
      },
      { kind: 'h', text: 'Self-funding sizing' },
      {
        kind: 'p',
        text: 'When the broker plans a deal it budgets: cash on hand, plus net sell proceeds (fees included), then sizes each buy so cash never goes negative — from the first fill to the last. If nothing can be funded, the proposal is rejected rather than issuing an unpayable deal.',
      },
    ],
  },
  {
    id: 'ledger',
    title: 'Evidence ledger',
    blurb: 'The tamper-evident record behind every deal.',
    blocks: [
      {
        kind: 'p',
        text: 'Every event — proposal, signature, fills, audit verdict, payment — is appended to an append-only SHA-256 hash chain (src/ledger.ts). Each entry stores the hash of the entry before it, so rewriting any past entry breaks every hash after it.',
      },
      {
        kind: 'p',
        text: 'On disk the chain lives at .local/dealflow/ledger.json. Event types: deal.proposed, deal.approved, deal.executed, deal.audited, deal.paid, and guardrail.emergency_stop.',
      },
      {
        kind: 'p',
        text: 'Everything that matters also survives a restart: the ledger re-derives the emergency-stop state, account.json saves the subaccount balances + cash after every fill, and deals.json snapshots in-flight deals after each state change.',
      },
      {
        kind: 'note',
        text: 'Try it yourself: edit a payload in .local/dealflow/ledger.json, restart the dashboard, and the chain will show as tampered and refuse verification.',
      },
      {
        kind: 'ul',
        items: [
          'verify() recomputes the whole chain and fails on any mismatch.',
          'Deals also pin the policy hash, so the rules a deal ran under are stable and checkable.',
          'The dashboard shows the chain root and its current verification status at all times.',
        ],
      },
    ],
  },
  {
    id: 'getting-started',
    title: 'Getting started',
    blurb: 'Install, run, test.',
    blocks: [
      {
        kind: 'code',
        text: 'npm install\nnpm run demo          # full lifecycle in the terminal (offline-safe)\nnpm test              # 30 unit tests\nnpm run typecheck     # backend type check',
      },
      { kind: 'p', text: 'Run the live server + dashboard:' },
      { kind: 'code', text: 'npm run start         # Express API + dashboard at http://127.0.0.1:4173' },
      { kind: 'p', text: 'Development short-circuits:' },
      {
        kind: 'code',
        text: 'npm run ui:build      # Vite build of the dashboard (served by the API)\nnpm run ui:dev        # Vite dev server on :5173, proxies /api\nnpm run typecheck:ui  # type check the ui/ tree\nnpm run lint          # Biome (style, correctness, unused imports)\nnpm run lint:fix      # safe auto-fix only',
      },
      { kind: 'h', text: 'Configuration' },
      {
        kind: 'table',
        head: ['Env var', 'Default', 'Meaning'],
        rows: [
          ['DEALFLOW_LIVE_MARKET', 'unset', '"1" = live Binance REST, else offline fixture'],
          ['DEALFLOW_PRINCIPAL_KEY', 'demo anvil key', 'key that signs deal intents'],
          ['DEALFLOW_WORKER_KEY', 'demo anvil key', 'auditor key + default fee destination'],
          ['DEALFLOW_WORKER_PAY_TO', 'worker key address', 'address receiving the fee via x402'],
          ['DEALFLOW_FEE_USDC', '12.50', 'broker fee per deal'],
        ],
      },
    ],
  },
  {
    id: 'architecture',
    title: 'Architecture',
    blurb: 'What lives where.',
    blocks: [
      {
        kind: 'table',
        head: ['Path', 'Responsibility'],
        rows: [
          ['src/domain/money.ts', '6-decimal atomic money, parse/serialize, bps math'],
          ['src/domain/policy.ts', 'immutable POLICY object + hash, proposal checks'],
          ['src/domain/deal.ts', 'state machine + canonical sell-first ordering'],
          ['src/domain/intent.ts', 'EIP-712 typed signing of a deal (signIntent, recoverSigner)'],
          ['src/agent/broker.ts', 'goal → priced deal; funds sells-first sizing'],
          ['src/agent/auditor.ts', 'independent reconciliation; signed verdict'],
          ['src/account.ts', 'virtual scoped subaccount with fill simulation'],
          ['src/ledger.ts', 'append-only SHA-256 evidence chain'],
          ['src/money/rail.ts', 'x402 PAYMENT-REQUIRED / PAYMENT-SIGNATURE wire format'],
          ['src/orchestrator.ts', 'the lifecycle: propose → approve → execute → audit → settle'],
          ['src/server.ts + ui/', 'Express API + this dashboard'],
          ['scripts/mcp.ts', 'stdio MCP server for agents'],
        ],
      },
    ],
  },
  {
    id: 'api',
    title: 'API reference',
    blurb: 'Every HTTP endpoint.',
    blocks: [
      {
        kind: 'table',
        head: ['Endpoint', 'Purpose'],
        rows: [
          ['GET /health', 'liveness + current ledger root'],
          ['GET /api/state', 'principal, worker, policy, portfolio (positions/NAV/weights), deals'],
          ['GET /api/market', 'quotes for the allowed symbols (fixture or live)'],
          ['POST /api/propose', '{job, targets} → creates a proposed deal'],
          ['POST /api/approve', '{dealId} → signs the EIP-712 intent as the principal'],
          ['POST /api/execute', '{dealId} → fills sells-first, then audits'],
          ['POST /api/settle', '{dealId} → x402 payout, refused unless audit passed'],
          ['POST /api/stop', 'emergency stop — rejects new proposals'],
          ['POST /api/resume', 'lifts the emergency stop; recovery is recorded on the ledger'],
          [
            'POST /api/restart',
            'reboots the broker from durable storage — ledger, portfolio and deals reload',
          ],
          ['GET /api/deals/:id', 'full detail for one deal (orders, receipts, audit, payment)'],
          ['GET /api/ledger', 'the whole evidence chain + verification result'],
        ],
      },
      {
        kind: 'note',
        text: 'The approve step signs with the demo principal key server-side — a stand-in for a wallet-injected signature. In production this would happen in your wallet, not the server.',
      },
    ],
  },
  {
    id: 'mcp',
    title: 'Agent tools (MCP)',
    blurb: 'What agents can call over stdio.',
    blocks: [
      {
        kind: 'p',
        text: 'The repo self-hosts a small MCP server so agents can inspect policy, read portfolio state, dry-run proposals, and verify the ledger — the same read path the dashboard uses.',
      },
      {
        kind: 'code',
        text: '{ "mcpServers": { "dealflow": { "command": "npx", "args": ["tsx", "scripts/mcp.ts"] } } }',
      },
      {
        kind: 'table',
        head: ['Tool', 'Does'],
        rows: [
          ['policy', 'return the standing guardrails + policy hash'],
          ['state', 'portfolio positions, NAV, weights, recent deals'],
          ['propose_deal', 'dry-run a proposal, policy-verified, no signature'],
          ['ledger_verify', 'recompute the chain and report integrity'],
        ],
      },
      {
        kind: 'note',
        text: 'Agents can plan and propose; only the principal can sign. That separation is the whole point.',
      },
    ],
  },
  {
    id: 'keys',
    title: 'Keys & demo mode',
    blurb: 'What is safe and what is not.',
    blocks: [
      {
        kind: 'p',
        text: 'Demo keys are Hardhat/Anvil accounts, hard-coded in src/runtime.ts for one reason: the demo runs with zero setup. Everything is simulated locally — fills, blocks, settlement.',
      },
      {
        kind: 'p',
        text: 'In production, keys come from the environment (DEALFLOW_PRINCIPAL_KEY, DEALFLOW_WORKER_KEY, DEALFLOW_WORKER_PAY_TO) and the signature step would happen in the principal’s wallet. The repo ships with demo keys only — do not point it at real funds.',
      },
    ],
  },
];

/* ------------------------------------------------------------------ utils */

function fmtUsd(atomic: string): string {
  return `$${(Number(atomic) / MICRO).toFixed(2)}`;
}

function fmtQty(q: string): string {
  const whole = Number(q) / MICRO;
  return whole >= 1000 ? whole.toFixed(0) : whole >= 1 ? whole.toFixed(4) : whole.toFixed(6);
}

function fmtPrice(micro: string): string {
  return `$${(Number(micro) / MICRO).toFixed(4)}`;
}

function truncate(mid: string, len = 8): string {
  return mid.length > len ? `${mid.slice(0, len)}…` : mid;
}

function guideIndexFor(status: DealStatus): number {
  switch (status) {
    case 'proposing':
      return 0;
    case 'proposed':
      return 1;
    case 'approved':
      return 2;
    case 'executing':
      return 3;
    case 'executed':
      return 4;
    case 'verified':
      return 5;
    case 'settled':
      return 6;
    default:
      return 0;
  }
}

/** tiny inline renderer: `code` spans inside paragraphs and list items */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/`([^`]+)`/g);
  let seed = 0;
  for (const part of parts) {
    if (part === '') continue;
    const key = `t${seed++}`;
    out.push(seed % 2 === 1 ? <code key={key}>{part}</code> : <span key={key}>{part}</span>);
  }
  return out;
}

/** stable key for a doc block (content-derived; enough for our static sections) */
function blockKey(b: DocBlock): string {
  switch (b.kind) {
    case 'p':
    case 'h':
    case 'note':
      return `${b.kind}:${b.text.slice(0, 32)}`;
    case 'ul':
    case 'ol':
      return `${b.kind}:${b.items[0]!.slice(0, 32)}`;
    case 'code':
      return `code:${b.text.slice(0, 32)}`;
    case 'table':
      return `table:${b.head.join('/').slice(0, 32)}`;
    case 'flow':
      return 'flow';
    default:
      return 'block';
  }
}

const ACTION_DONE: Record<string, string> = {
  approve: 'Intent signed by the principal.',
  execute: 'Deal executed and audited.',
  settle: 'Fee released via x402 — payment complete.',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `Backend replied with non-JSON (HTTP ${res.status}) — restart the broker server to pick up the latest build`,
    );
  }
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

/* ------------------------------------------------------------------ app */

export function App() {
  const [tab, setTab] = useState<'dashboard' | 'docs'>('dashboard');
  const [state, setState] = useState<State | null>(null);
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, number>>({ ...DEFAULT_TARGETS });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  function notify(text: string, tone: ToastTone = 'good') {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([api<State>('/api/state'), api<LedgerView>('/api/ledger')]);
      setState(s);
      setLedger(l);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
  }, [refresh]);

  async function post(path: string, body: unknown, okMsg?: string) {
    setBusy(true);
    setError(null);
    try {
      await api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (okMsg) notify(okMsg);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  if (!state || !ledger) {
    return (
      <div className="app">
        <Nav
          tab="dashboard"
          onTab={() => undefined}
          state={null}
          now={now}
          onRestart={() => undefined}
          busy={false}
        />
        <main className="shell">
          <div className="skeleton-stack" aria-hidden="true">
            <div className="skeleton skeleton-block" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line short" />
          </div>
          <p className="muted" role="status">
            connecting to broker…
          </p>
          {error && <pre className="err">{error}</pre>}
        </main>
      </div>
    );
  }

  const latest = state.deals[0];
  const guideStep = latest ? guideIndexFor(latest.status) : 0;

  return (
    <div className="app">
      <Nav
        tab={tab}
        onTab={setTab}
        state={state}
        now={now}
        busy={busy}
        onRestart={() => {
          post(
            '/api/restart',
            {},
            'Broker restarted — ledger, portfolio and deals reloaded from durable storage.',
          );
        }}
      />
      <main className="shell">
        {!state.alive && (
          <StoppedBanner
            onResume={() => post('/api/resume', {}, 'Broker resumed — proposals accepted again.')}
          />
        )}
        {error && <pre className="err">⚠ {error}</pre>}
        {tab === 'dashboard' ? (
          <Dashboard
            state={state}
            ledger={ledger}
            guideStep={guideStep}
            targets={targets}
            setTargets={setTargets}
            busy={busy}
            onPropose={() =>
              post(
                '/api/propose',
                { job: 'rebalance to selected weights', targets },
                'Deal proposed — review it in Deals below.',
              )
            }
            onStop={() => post('/api/stop', {}, 'Emergency stop engaged. Resume when ready.')}
            onResume={() => post('/api/resume', {}, 'Broker resumed — proposals accepted again.')}
            onDrive={(id, ep) => post(`/api/${ep}`, { dealId: id }, ACTION_DONE[ep] ?? 'Done.')}
            onReadDocs={() => setTab('docs')}
          />
        ) : (
          <DocsView />
        )}
        <div className="sysstrip">
          <span className="muted mono">principal {truncate(state.principal, 14)}</span>
          <span className="muted mono">worker {state.worker}</span>
          <span className="muted mono">policy {state.policyHash.slice(0, 14)}…</span>
          <span className="muted mono">
            ledger {ledger.verified ? '✓ intact' : '✗ tampered'} {ledger.root.slice(0, 10)}…
          </span>
        </div>
      </main>
      <footer className="footer">
        <span className="muted">
          dealflow v0.1.0 · {SYMBOLS.join(' / USDT ')} · demo keys only — not for production
        </span>
      </footer>
      <ToastStack toasts={toasts} />
    </div>
  );
}

function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function StoppedBanner({ onResume }: { onResume: () => void }) {
  return (
    <section className="stop-banner" role="alert">
      <div>
        <strong>Emergency stop engaged.</strong>
        <span className="muted">
          {' '}
          The broker rejects all new proposals until you resume. The stop was recorded on the evidence ledger.
        </span>
      </div>
      <button type="button" className="btn btn-primary" onClick={onResume}>
        Resume broker
      </button>
    </section>
  );
}

function Nav({
  tab,
  onTab,
  state,
  now,
  busy,
  onRestart,
}: {
  tab: 'dashboard' | 'docs';
  onTab: (t: 'dashboard' | 'docs') => void;
  state: State | null;
  now: Date;
  busy: boolean;
  onRestart: () => void;
}) {
  return (
    <header className="nav">
      <div className="nav-left">
        <div className="logo" role="img" aria-label="dealflow — The Broker" title="dealflow — The Broker">
          <svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
            <circle cx="18" cy="18" r="11.5" fill="none" stroke="#fff" strokeWidth="2.2" />
            <path
              d="M12.6 18.4 L15.8 21.6 L23.4 14"
              fill="none"
              stroke="#fff"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="18" cy="18" r="2.6" fill="#fff" />
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-name">
            Dealflow <span className="brand-sep">· The Broker</span>
          </div>
          <div className="brand-sub">Pay-per-outcome agents</div>
        </div>
      </div>
      <nav className="tabs">
        <button
          type="button"
          className={`tab ${tab === 'dashboard' ? 'active' : ''}`}
          onClick={() => onTab('dashboard')}
        >
          Dashboard
        </button>
        <button
          type="button"
          className={`tab ${tab === 'docs' ? 'active' : ''}`}
          onClick={() => onTab('docs')}
        >
          Docs
        </button>
      </nav>
      <div className="nav-right">
        <button
          type="button"
          className="btn btn-sm btn-restart"
          onClick={onRestart}
          disabled={busy}
          title="Reboots the broker from durable storage — ledger, portfolio and deals are reloaded from the evidence chain."
        >
          {busy ? 'Working…' : 'Restart broker'}
        </button>
        {state && (
          <>
            <span
              className={`pill ${state.alive ? 'good' : 'bad'} ${state.alive ? '' : 'pulse'}`}
              title={state.alive ? 'Broker accepts and executes proposals' : 'Emergency stop engaged'}
            >
              {state.alive ? 'broker live' : 'stopped — needs resume'}
            </span>
            <span
              className={`pill ${state.alive ? 'good' : 'bad'}`}
              title={state.alive ? 'Evidence chain intact' : 'Evidence chain check failed'}
            >
              {state.alive ? 'ledger ✓' : 'ledger ✗'}
            </span>
          </>
        )}
        <span className="pill clock mono">{now.toISOString().slice(11, 19)}Z</span>
      </div>
    </header>
  );
}

function Dashboard({
  state,
  ledger,
  guideStep,
  targets,
  setTargets,
  busy,
  onPropose,
  onStop,
  onResume,
  onDrive,
  onReadDocs,
}: {
  state: State;
  ledger: LedgerView | null;
  guideStep: number;
  targets: Record<string, number>;
  setTargets: (t: Record<string, number>) => void;
  busy: boolean;
  onPropose: () => void;
  onStop: () => void;
  onResume: () => void;
  onDrive: (id: string, ep: string) => void;
  onReadDocs: () => void;
}) {
  return (
    <>
      <section className="hero">
        <div className="hero-main">
          <h2 className="hero-title">Pay for provable work, not promises.</h2>
          <p className="hero-sub muted">
            A goal becomes a priced deal: you sign it, a broker fills it on a scoped subaccount, an auditor
            checks it, and only then does the fee release. Every step lands on a tamper-evident ledger.
          </p>
          <div className="hero-actions">
            <button type="button" className="btn btn-primary" onClick={onReadDocs}>
              Read the docs
            </button>
            <span className="hero-status muted mono">{state.principal.slice(0, 10)}…</span>
          </div>
        </div>
        <LifecycleStrip step={guideStep} onReadDocs={onReadDocs} />
      </section>

      <div className="grid">
        <PortfolioCard portfolio={state.portfolio} />
        <ProposerCard
          targets={targets}
          setTargets={setTargets}
          policy={state.policy}
          portfolio={state.portfolio}
          busy={busy}
          alive={state.alive}
          onPropose={onPropose}
          onStop={onStop}
          onResume={onResume}
        />
      </div>

      <DealsSection deals={state.deals} onDrive={onDrive} busy={busy} />
      <LedgerSection ledger={ledger} />
    </>
  );
}

function LifecycleStrip({ step, onReadDocs }: { step: number; onReadDocs: () => void }) {
  return (
    <div className="lifecycle">
      <div className="lifecycle-head">
        <span className="lifecycle-title">Deal lifecycle — step {Math.min(step + 1, 7)} of 7</span>
        <button type="button" className="link" onClick={onReadDocs}>
          how it works →
        </button>
      </div>
      <div className="dots">
        {GUIDE.map((g, i) => {
          const reached = i <= step;
          const current = i === step;
          return (
            <div key={g.title} className={`dot-wrap ${reached ? 'reached' : ''} ${current ? 'current' : ''}`}>
              <div className="dot" title={g.short}>
                {reached ? '✓' : i + 1}
              </div>
              <div className="dot-label muted">{g.title}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PortfolioCard({ portfolio }: { portfolio: Portfolio }) {
  const navUsd = Number(portfolio.navAtomic) / MICRO;
  const cashUsd = Number(portfolio.cashAtomic) / MICRO;
  const cashW = (Number(portfolio.cashWeight) / 1e7) * 100;
  return (
    <section className="card">
      <h3 className="card-title">Portfolio</h3>
      <div className="metrics">
        <div className="metric">
          <div className="metric-label muted">NAV</div>
          <div className="metric-value">${navUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
        </div>
        <div className="metric">
          <div className="metric-label muted">Cash</div>
          <div className="metric-value">${cashUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
        </div>
        <div className="metric">
          <div className="metric-label muted">Cash weight</div>
          <div className="metric-value">{cashW.toFixed(1)}%</div>
        </div>
      </div>
      <div className="holds">
        {SYMBOLS.map((s) => {
          const value = Number(portfolio.valuesUsd[s] ?? '0') / MICRO;
          const weight = (Number(portfolio.weights[s] ?? '0') / 1e7) * 100;
          return (
            <div className="hold" key={s}>
              <div className="hold-row">
                <span className="hold-sym">{s}</span>
                <span className="muted mono hold-qty">{portfolio.balances[s] ?? '0'}</span>
                <span className="mono hold-val">
                  ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
                <span className="muted hold-w">{weight.toFixed(1)}%</span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${Math.min(100, weight)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted note">Live subaccount state the broker prices the next deal against.</p>
    </section>
  );
}

function ProposerCard({
  targets,
  setTargets,
  policy,
  portfolio,
  busy,
  alive,
  onPropose,
  onStop,
  onResume,
}: {
  targets: Record<string, number>;
  setTargets: (t: Record<string, number>) => void;
  policy: PolicyView;
  portfolio: Portfolio;
  busy: boolean;
  alive: boolean;
  onPropose: () => void;
  onStop: () => void;
  onResume: () => void;
}) {
  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  const over = sum > 1 + 1e-9;
  const MIN_TRADE_USD = 10_000_000n; // $10 — mirrors the broker's minimum leg
  const nav = BigInt(portfolio.navAtomic);
  const usdToMicro = (v: string) => BigInt(Math.round(Number(v) * 1_000_000));
  const drift = SYMBOLS.map((s) => {
    const targetUsd = (nav * BigInt(Math.round(targets[s]! * 1_000_000))) / 10n ** 6n;
    const currentUsd = usdToMicro(portfolio.valuesUsd[s] ?? '0');
    return targetUsd - currentUsd;
  });
  const driftUsd = drift.reduce((a, b) => a + (b < 0n ? -b : b), 0n);
  const noOp = drift.every((d) => (d < 0n ? -d : d) < MIN_TRADE_USD);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);

  function arm() {
    setArmed(true);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => setArmed(false), 4000);
  }

  function stop() {
    setArmed(false);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    onStop();
  }

  function nowPct(s: string): string {
    const v = usdToMicro(portfolio.valuesUsd[s] ?? '0');
    return nav > 0n ? ((v * 1000n) / nav / 10n).toString() : '0';
  }

  const fmtDriftUsd = `$${(Math.round(Number(driftUsd) / 10_000_000) / 100).toFixed(2)}`;
  const proposeTitle = !alive
    ? 'Broker is stopped — resume first'
    : over
      ? `Weights sum to ${Math.round(sum * 100)}% — policy caps at 100%`
      : noOp
        ? 'Portfolio already matches these targets — tweak a weight above to open a deal'
        : 'Prices the goal into a bounded, signed-ready deal';

  return (
    <section className="card">
      <h3 className="card-title">Start a deal</h3>
      <p className="muted">
        Target portfolio weights — the broker rebalances toward these. Must sum to ≤ 100%.
      </p>
      <div className="targets">
        {SYMBOLS.map((s) => (
          <label key={s} className="target">
            <span className="muted">{s} / USDT</span>
            <input
              type="number"
              step="0.05"
              min="0"
              max={policy.maxHoldingWeight}
              value={targets[s]}
              disabled={!alive}
              onChange={(e) => setTargets({ ...targets, [s]: Number(e.target.value) })}
            />
            <span className="pct mono">{(targets[s] * 100).toFixed(0)}%</span>
            <em className="now muted mono">now {nowPct(s)}%</em>
          </label>
        ))}
      </div>
      <div className={`sum ${over ? 'bad' : ''}`}>
        Σ {Math.round(sum * 100)}%
        <span className="muted">
          {' '}
          · drift ≈ {fmtDriftUsd}
          {noOp && ' — already at target'}
        </span>
        {over && <span className="muted"> — policy caps total at 100%</span>}
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onPropose}
          disabled={busy || !alive || over || noOp}
          title={proposeTitle}
        >
          {busy ? 'Working…' : 'Propose deal'}
        </button>
        {alive ? (
          <button
            type="button"
            className={`btn btn-danger ${armed ? 'armed' : ''}`}
            onClick={() => (armed ? stop() : arm())}
            title={
              armed ? 'Tap again to confirm the emergency stop' : 'Reject all new proposals until you resume'
            }
            aria-pressed={armed}
          >
            {armed ? 'Tap again to confirm' : 'Emergency stop'}
          </button>
        ) : (
          <button type="button" className="btn btn-ok" onClick={onResume}>
            Resume broker
          </button>
        )}
      </div>
      {noOp && !busy && (
        <p className="muted stop-note">
          These targets already mirror the portfolio — tweak a weight above to open a new deal.
        </p>
      )}
      {!alive && (
        <p className="muted stop-note">
          Broker is stopped — new proposals are rejected until you resume. The stop (and resume) are both
          recorded on the evidence ledger.
        </p>
      )}
      <ul className="microcopy">
        <li>
          ≤ ${policy.maxNotionalUsd.toFixed(0)} notional per deal · ≤ {policy.maxSlippageBps}bps slippage
        </li>
        <li>{policy.roundTrip ? 'no round-trips' : 'round-trips allowed'}</li>
        <li>buys are sized against cash + this deal&apos;s sell proceeds − fees</li>
      </ul>
    </section>
  );
}

function DealsSection({
  deals,
  onDrive,
  busy,
}: {
  deals: State['deals'];
  onDrive: (id: string, ep: string) => void;
  busy: boolean;
}) {
  return (
    <section className="card section">
      <div className="card-head">
        <h3 className="card-title">Deals</h3>
        <span className="count muted mono">{deals.length}</span>
      </div>
      {deals.length === 0 && (
        <p className="muted">
          No deals yet. Set target weights above and hit <strong>Propose deal</strong>.
        </p>
      )}
      {deals.map((d) => (
        <DealCard key={d.id} summary={d} onDrive={(ep) => onDrive(d.id, ep)} busy={busy} />
      ))}
    </section>
  );
}

function DealCard({
  summary,
  onDrive,
  busy,
}: {
  summary: State['deals'][number];
  onDrive: (endpoint: string) => void;
  busy: boolean;
}) {
  const full = useLoadedDeal(summary.id, summary.status);
  const action = NEXT_ACTION[summary.status];
  const st = STATUS[summary.status];
  return (
    <article className="deal">
      <div className="deal-head">
        <span className="cid mono muted">{truncate(summary.id, 10)}</span>
        <strong className="job">{summary.job || 'rebalance'}</strong>
        <span className={`chip chip-${st.tone}`}>{st.label}</span>
        <span className="muted mono">
          {fmtUsd(summary.fee)} fee · {summary.orders} legs
        </span>
        <span className="spacer" />
        {action && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onDrive(action.endpoint)}
            disabled={busy}
            title={
              busy
                ? 'A broker action is in flight — wait a moment'
                : `${action.label} — the human-in-the-loop check`
            }
          >
            {busy ? 'Working…' : action.label}
          </button>
        )}
      </div>
      {full && (
        <div className="deal-body">
          <div className="plan">
            <div className="plan-label muted">Broker plan</div>
            <pre className="summary mono">{full.deal.summaryLines.join('\n')}</pre>
          </div>
          <div className="legs">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Limit</th>
                  <th>Slip</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {full.deal.orders.map((o) => {
                  const r = full.deal.receipts?.find((x) => x.clientOrderId === o.clientOrderId);
                  return (
                    <tr key={o.clientOrderId}>
                      <td>{o.symbol}/USDT</td>
                      <td className={o.side === 'buy' ? 'buy' : 'sell'}>{o.side}</td>
                      <td className="mono">{fmtQty(o.quantity)}</td>
                      <td className="mono">{fmtPrice(o.limitPriceMicro)}</td>
                      <td className="mono">{o.maxSlippageBps}bps</td>
                      <td>
                        {r ? (
                          <span className={r.status === 'filled' ? 'good' : 'bad'}>{r.status}</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted legs-note">Orders execute sells-first — the deal funds itself as it fills.</p>
          </div>
          {full.deal.audit && (
            <div className={`banner ${full.deal.audit.passed ? 'good' : 'bad'}`}>
              <strong>{full.deal.audit.passed ? '✓ Audit passed' : '✗ Audit failed'}</strong>
              <span className="checks">
                {full.deal.audit.checks.map((c) => (
                  <span key={c.name} className={c.ok ? 'good' : 'bad'}>
                    {c.ok ? '✓' : '✗'} {c.name}
                  </span>
                ))}
              </span>
              <span className="muted mono">signed {truncate(full.deal.audit.signedBy, 12)}</span>
            </div>
          )}
          {full.deal.payment && (
            <div className="banner paid">
              <strong>Paid · {full.deal.payment.rail}</strong>
              <span className="muted mono">
                to {truncate(full.deal.payment.payTo, 14)} · tx {truncate(full.deal.payment.txHash, 16)}
              </span>
            </div>
          )}
          {action && (
            <p className="muted hint">
              Next: <strong>{action.label}</strong>. This button is the human-in-the-loop check — the broker
              cannot skip it.
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function useLoadedDeal(id: string, status: DealStatus): { deal: Deal } | null {
  const [loaded, setLoaded] = useState<{ deal: Deal } | null>(null);
  useEffect(() => {
    void status;
    let alive = true;
    api<{ deal: Deal }>(`/api/deals/${id}`)
      .then((d) => alive && setLoaded(d))
      .catch(() => alive && setLoaded(null));
    return () => {
      alive = false;
    };
  }, [id, status]);
  return loaded;
}

function LedgerSection({ ledger }: { ledger: LedgerView | null }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="card section">
      <div className="card-head">
        <h3 className="card-title">Evidence ledger</h3>
        <span className={`pill ${ledger?.verified ? 'good' : 'bad'}`}>
          {ledger?.verified ? 'verified' : 'checking…'}
        </span>
        <span className="spacer" />
        <button type="button" className="link" onClick={() => setOpen((o) => !o)}>
          {open ? 'collapse' : 'expand'}
        </button>
      </div>
      {open && ledger && (
        <div className="chain">
          {ledger.entries.slice(-12).map((e) => (
            <div className="entry" key={e.seq}>
              <div className="seq mono muted">{e.seq.toString().padStart(2, '0')}</div>
              <div className="entry-body">
                <code className="kind">{e.kind}</code>
                <pre className="entry-payload mono">{String(JSON.stringify(e.payload)).slice(0, 140)}</pre>
                <div className="muted mono entry-hash">
                  {truncate(e.hash, 24)} <span className="arrow">→</span> prev {truncate(e.prevHash, 10)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="muted note">
        Append-only hash chain — {ledger?.entries.length ?? 0} events, current root{' '}
        <code>{ledger ? truncate(ledger.root, 18) : '…'}</code>. Every state change is one entry. Read the
        docs to see why it can never be rewritten.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ docs */

function DocsView() {
  const [activeId, setActiveId] = useState('overview');
  const section = DOCS.find((d) => d.id === activeId) ?? DOCS[0]!;
  return (
    <div className="docs">
      <aside className="docs-nav">
        <div className="docs-nav-title muted">Read the docs</div>
        {DOCS.map((d) => (
          <button
            type="button"
            key={d.id}
            className={`docs-link ${d.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(d.id)}
          >
            {d.title}
            <span className="docs-link-desc">{d.blurb}</span>
          </button>
        ))}
      </aside>
      <article className="docs-body">
        <h2 className="docs-title">{section.title}</h2>
        {section.blocks.map((b) => (
          <DocBlockView b={b} key={blockKey(b)} />
        ))}
      </article>
    </div>
  );
}

function DocBlockView({ b }: { b: DocBlock }) {
  switch (b.kind) {
    case 'p':
      return <p className="doc-p">{inline(b.text)}</p>;
    case 'h':
      return <h3 className="doc-h">{b.text}</h3>;
    case 'ul':
      return (
        <ul className="doc-list">
          {b.items.map((it) => (
            <li key={`li-${it.slice(0, 24)}`}>{inline(it)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="doc-list">
          {b.items.map((it) => (
            <li key={`li-${it.slice(0, 24)}`}>{inline(it)}</li>
          ))}
        </ol>
      );
    case 'note':
      return <div className="doc-note">{inline(b.text)}</div>;
    case 'code':
      return <pre className="doc-code mono">{b.text}</pre>;
    case 'table':
      return (
        <table className="doc-table">
          <thead>
            <tr>
              {b.head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r) => (
              <tr key={r[0]!}>
                {r.map((c) => (
                  <td key={c}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'flow':
      return (
        <div className="flow">
          {GUIDE.map((g, i) => (
            <div className="flow-step" key={g.title}>
              <div className="flow-step-top">
                <span className="flow-num">{i + 1}</span>
                <span className="flow-title">{g.title}</span>
                {i < GUIDE.length - 1 && <span className="flow-arrow">→</span>}
              </div>
              <div className="flow-body muted">{g.short}</div>
            </div>
          ))}
        </div>
      );
    default:
      return null;
  }
}
