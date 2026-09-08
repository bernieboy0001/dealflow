import { type ReactNode, useCallback, useEffect, useState } from 'react';

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

type Quote = {
  symbol: string;
  price: string;
  bid: string;
  ask: string;
  changePct: string;
  source: 'binance' | 'fixture';
  at: string;
};

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

const STATUS: Record<DealStatus, { label: string; color: string }> = {
  proposing: { label: 'proposing', color: '#848E9C' },
  proposed: { label: 'awaiting signature', color: '#4DA6FF' },
  approved: { label: 'signed — ready', color: '#9155FF' },
  executing: { label: 'executing', color: '#F0B90B' },
  executed: { label: 'executed', color: '#0ECB81' },
  verified: { label: 'verified', color: '#0ECB81' },
  settled: { label: 'paid', color: '#0ECB81' },
  rejected: { label: 'rejected', color: '#F6465D' },
  cancelled: { label: 'cancelled', color: '#848E9C' },
  failed: { label: 'failed', color: '#F6465D' },
};

const NEXT_ACTION: Record<DealStatus, { label: string; endpoint: string } | null> = {
  proposing: null,
  proposed: { label: 'sign intent (EIP-712)', endpoint: 'approve' },
  approved: { label: 'execute + audit', endpoint: 'execute' },
  executing: null,
  executed: null,
  verified: { label: 'settle — release fee (x402)', endpoint: 'settle' },
  settled: null,
  rejected: null,
  cancelled: null,
  failed: null,
};

/** The lifecycle the UI teaches: each step maps to the broker's real pipeline. */
const GUIDE: { title: string; body: string; step: string }[] = [
  {
    step: '01',
    title: 'Propose',
    body: 'The broker reads the subaccount, prices the move from binance, and writes a deterministic plan: legs, limits, worker fee, and the pinned policy hash. Nothing is signed yet.',
  },
  {
    step: '02',
    title: 'Pin policy',
    body: 'The proposal carries the hash of the standing deal policy. If the rules ever change, old proposals no longer match it — you always know which rules a deal ran under.',
  },
  {
    step: '03',
    title: 'Sign intent',
    body: 'You sign the EIP-712 intent with the principal key. Execution is gated on a signature that recovers to your address. No signature, no trade.',
  },
  {
    step: '04',
    title: 'Execute',
    body: 'Orders run in canonical order — sells first, then buys — so the deal funds itself from cash plus sale proceeds. Every fill is captured as a signed receipt.',
  },
  {
    step: '05',
    title: 'Audit',
    body: 'An independent auditor re-checks every leg against the signed intent and the policy, then signs the verdict. A signed PASS is what unlocks payment.',
  },
  {
    step: '06',
    title: 'Settle',
    body: 'An x402 “up-to” authorization releases the worker fee to the worker’s address — only after the audit PASS. Pay-per-outcome, in code.',
  },
  {
    step: '07',
    title: 'Seal ledger',
    body: 'Every event (propose, sign, fills, verdict, payment) is appended to an append-only hash chain. The UI shows the root it verifies right now.',
  },
];

const RULE_MEANING: { key: keyof PolicyView; label: string; fmt: (p: PolicyView) => string; why: string }[] =
  [
    {
      key: 'maxNotionalUsd',
      label: 'Max notional / deal',
      fmt: (p) => `$${p.maxNotionalUsd.toFixed(0)} USDC`,
      why: 'hard ceiling on buy-side notional for a single deal',
    },
    {
      key: 'maxSlippageBps',
      label: 'Max slippage',
      fmt: (p) => `${p.maxSlippageBps} bps`,
      why: 'limit price is marked ± this spread against bid/ask',
    },
    {
      key: 'maxTotalFeeBps',
      label: 'Exchange fee budget',
      fmt: (p) => `${p.maxTotalFeeBps} bps`,
      why: 'reserved per leg when sizing buys against your cash',
    },
    {
      key: 'maxFeeUsd',
      label: 'Max worker fee',
      fmt: (p) => `$${p.maxFeeUsd.toFixed(2)} USDC`,
      why: 'the broker cannot charge more than this per deal',
    },
    {
      key: 'maxHoldingWeight',
      label: 'Max holding weight',
      fmt: (p) => `${Math.round(p.maxHoldingWeight * 100)}%`,
      why: 'no single asset target may exceed this share of NAV',
    },
    {
      key: 'brokerFeeUsd',
      label: 'Broker fee (this deal)',
      fmt: (p) => `$${p.brokerFeeUsd.toFixed(2)} USDC`,
      why: 'paid via x402 only after the audit PASS',
    },
    {
      key: 'roundTrip',
      label: 'Round-trips',
      fmt: (p) => (p.roundTrip ? 'blocked' : 'allowed'),
      why: 'a deal may not buy and sell the same symbol',
    },
  ];

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

function fmtPct(changePct: string): string {
  const n = Number(changePct);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function truncate(mid: string, len = 8): string {
  return mid.length > len ? `${mid.slice(0, len)}…` : mid;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

/** maps a deal status to the furthest guide step reached (index into GUIDE) */
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

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, number>>({ ...DEFAULT_TARGETS });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const refresh = useCallback(async () => {
    try {
      const [s, l, q] = await Promise.all([
        api<State>('/api/state'),
        api<LedgerView>('/api/ledger'),
        api<{ quotes: Quote[] }>('/api/market'),
      ]);
      setState(s);
      setLedger(l);
      setQuotes(q.quotes);
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

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!state || !ledger) {
    return (
      <main className="shell">
        <p className="muted">connecting to broker…</p>
        {error && <pre className="err">{error}</pre>}
      </main>
    );
  }

  const latest = state.deals[0];
  const guideStep = latest ? guideIndexFor(latest.status) : 0;
  const sumTargets = Object.values(targets).reduce((a, b) => a + b, 0);

  return (
    <main className="shell">
      <TopBar alive={state.alive} ledgerVerified={ledger.verified} ledgerRoot={ledger.root} now={now} />

      {error && <pre className="err">⚠ {error}</pre>}

      <TickerStrip quotes={quotes} />

      <Guide step={guideStep} />

      <div className="grid">
        <PortfolioPanel portfolio={state.portfolio} />
        <Proposer
          targets={targets}
          setTargets={setTargets}
          sum={sumTargets}
          policy={state.policy}
          busy={busy}
          alive={state.alive}
          onPropose={() => post('/api/propose', { job: 'rebalance to weights', targets })}
          onStop={() => post('/api/stop', {})}
        />
      </div>

      <section className="panel">
        <PanelTitle count={state.deals.length}>Deals</PanelTitle>
        {state.deals.length === 0 && (
          <p className="muted">
            no deals yet — propose one above. Follow the numbered guide to see how a payout becomes a deal.
          </p>
        )}
        {state.deals.map((d) => (
          <DealCard
            key={d.id}
            summary={d}
            onDrive={(ep) => post(`/api/${ep}`, { dealId: d.id })}
            busy={busy}
          />
        ))}
      </section>

      <LedgerPanel ledger={ledger} />
      <PolicyPanel state={state} />
    </main>
  );
}

function PanelTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h2 className="panel-title">
      {children}
      {count !== undefined && <span className="count">{count}</span>}
    </h2>
  );
}

function TopBar({
  alive,
  ledgerVerified,
  ledgerRoot,
  now,
}: {
  alive: boolean;
  ledgerVerified: boolean;
  ledgerRoot: string;
  now: Date;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo">D</div>
        <div>
          <h1>
            dealflow <span className="gold">·</span> The Broker
          </h1>
          <p className="muted">
            pay-per-outcome agents on Agent OS — work is a priced deal, paid only when it checks out
          </p>
        </div>
      </div>
      <div className="topbar-right">
        <div className={`pill ${ledgerVerified ? 'green' : 'red'}`} title="append-only evidence chain">
          {ledgerVerified ? '✓ ledger' : '✗ tampered'}
        </div>
        <div className={`pill ${alive ? 'green' : 'red'}`}>{alive ? '● broker live' : '○ stopped'}</div>
        <div className="pill clock mono">
          {now.toISOString().slice(11, 19)}
          <span className="muted"> · {truncate(ledgerRoot)}</span>
        </div>
      </div>
    </header>
  );
}

function TickerStrip({ quotes }: { quotes: Quote[] }) {
  if (quotes.length === 0) return null;
  return (
    <div className="ticker">
      {quotes.map((q) => {
        const up = Number(q.changePct) >= 0;
        return (
          <div className={`tick ${up ? 'up' : 'down'}`} key={q.symbol}>
            <div className="tick-name">
              {q.symbol}/USDT <span className="src">{q.source}</span>
            </div>
            <div className="tick-price">
              $
              {Number(q.price).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
            <div className="tick-meta">
              bid {q.bid} · ask {q.ask} · 24h{' '}
              <span className={up ? 'up' : 'down'}>{fmtPct(q.changePct)}</span>
            </div>
          </div>
        );
      })}
      <div className="tick-live mono">{new Date().toISOString().slice(11, 19)}Z</div>
    </div>
  );
}

function Guide({ step }: { step: number }) {
  return (
    <section className="panel guide">
      <PanelTitle>How a deal gets paid</PanelTitle>
      <ol className="steps">
        {GUIDE.map((g, i) => {
          const reached = i <= step;
          const current = i === step;
          return (
            <li key={g.title} className={`step ${reached ? 'reached' : ''} ${current ? 'current' : ''}`}>
              <div className="step-badge">{reached ? '✓' : g.step}</div>
              <div className="step-body">
                <div className="step-title">{g.title}</div>
                <div className="step-text">{g.body}</div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="muted guide-note">
        The dark nodes are steps already proven by the latest deal. Nothing is automatic: every transition is
        a separate, signed, auditable event.
      </p>
    </section>
  );
}

function PortfolioPanel({ portfolio }: { portfolio: Portfolio }) {
  const navUsd = Number(portfolio.navAtomic) / MICRO;
  const cashUsd = Number(portfolio.cashAtomic) / MICRO;
  const cashW = Number(portfolio.cashWeight) / 1e7;
  return (
    <section className="panel">
      <PanelTitle>Subaccount · {SYMBOLS.length} + cash</PanelTitle>
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
          <div className="metric-value">{(cashW * 100).toFixed(1)}%</div>
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
                <span className="mono">
                  {portfolio.balances[s] ?? '0'} · $
                  {value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
                <span className="muted">{weight.toFixed(1)}% of NAV</span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${Math.min(100, weight)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted">
        Balances are the live subaccount state the broker prices your next deal against.
      </p>
    </section>
  );
}

function Proposer({
  targets,
  setTargets,
  sum,
  policy,
  busy,
  alive,
  onPropose,
  onStop,
}: {
  targets: Record<string, number>;
  setTargets: (t: Record<string, number>) => void;
  sum: number;
  policy: PolicyView;
  busy: boolean;
  alive: boolean;
  onPropose: () => void;
  onStop: () => void;
}) {
  const over = sum > 1 + 1e-9;
  return (
    <section className="panel">
      <PanelTitle>Start a deal</PanelTitle>
      <p className="muted">
        Target portfolio weights — the broker rebalances toward these. Weights must sum to ≤ 100%.
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
              onChange={(e) => setTargets({ ...targets, [s]: Number(e.target.value) })}
            />
            <span className="pct mono">{(targets[s] * 100).toFixed(0)}%</span>
          </label>
        ))}
      </div>
      <div className={`sum ${over ? 'bad' : ''}`}>
        Σ {Math.round(sum * 100)}%{over && <span className="muted"> — policy caps total at 100%</span>}
      </div>
      <div className="actions">
        <button type="button" className="primary" onClick={onPropose} disabled={busy || !alive || over}>
          {busy ? 'working…' : 'propose deal'}
        </button>
        <button type="button" className="danger" onClick={onStop} disabled={!alive}>
          emergency stop
        </button>
      </div>
      <ul className="microcopy">
        <li>
          ≤ ${policy.maxNotionalUsd}/deal notional · ≤ {policy.maxSlippageBps}bps slippage
        </li>
        <li>{policy.roundTrip ? 'no round-trips' : 'round-trips allowed'}</li>
        <li>buys are sized against cash + this deal&apos;s sell proceeds − fees</li>
      </ul>
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
        <span className="cid mono">{truncate(summary.id, 10)}</span>
        <strong className="job">{summary.job}</strong>
        <span className="status-chip" style={{ color: st.color, borderColor: st.color }}>
          {st.label}
        </span>
        <span className="muted mono">
          {fmtUsd(summary.fee)} fee · {summary.orders} legs
        </span>
        <span className="spacer" />
        {action && (
          <button
            type="button"
            className="primary small"
            onClick={() => onDrive(action.endpoint)}
            disabled={busy}
          >
            {action.label}
          </button>
        )}
      </div>
      {full && (
        <div className="deal-body">
          <div className="plan">
            <div className="plan-label muted">broker plan</div>
            <pre className="summary">{full.deal.summaryLines.join('\n')}</pre>
          </div>
          <div className="legs">
            <table>
              <thead>
                <tr>
                  <th>symbol</th>
                  <th>side</th>
                  <th>qty</th>
                  <th>limit</th>
                  <th>slip</th>
                  <th>receipt</th>
                </tr>
              </thead>
              <tbody>
                {full.deal.orders.map((o) => {
                  const r = full.deal.receipts?.find((x) => x.clientOrderId === o.clientOrderId);
                  return (
                    <tr key={o.clientOrderId}>
                      <td>{o.symbol}/USDT</td>
                      <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side}</td>
                      <td>{fmtQty(o.quantity)}</td>
                      <td>{fmtPrice(o.limitPriceMicro)}</td>
                      <td>{o.maxSlippageBps}bps</td>
                      <td>
                        {r ? (
                          <span className={r.status === 'filled' ? 'up' : 'down'}>{r.status}</span>
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
            <div className={`banner ${full.deal.audit.passed ? 'green' : 'red'}`}>
              <strong>{full.deal.audit.passed ? '✓ audit PASS' : '✗ audit FAIL'}</strong>
              <span className="checks">
                {full.deal.audit.checks.map((c) => (
                  <span key={c.name} className={c.ok ? 'up' : 'down'}>
                    {c.ok ? '✓' : '✗'} {c.name}
                    {c.detail ? ` (${c.detail})` : ''}
                  </span>
                ))}
              </span>
              <span className="mono muted">signed {truncate(full.deal.audit.signedBy, 12)}</span>
            </div>
          )}
          {full.deal.payment && (
            <div className="banner green paid">
              <strong>paid · {full.deal.payment.rail}</strong>
              <span className="checks mono">to {truncate(full.deal.payment.payTo, 14)}</span>
              <span className="mono muted">tx {truncate(full.deal.payment.txHash, 16)}</span>
            </div>
          )}
          {action && (
            <p className="muted hint">
              next: <strong>{action.label}</strong> — this button is the human-in-the-loop check. The broker
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
    // refetch the full detail whenever the deal advances to a new status
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

function LedgerPanel({ ledger }: { ledger: LedgerView }) {
  return (
    <section className="panel">
      <PanelTitle>
        Evidence ledger{' '}
        <span className={`badge ${ledger.verified ? 'green' : 'red'}`}>
          {ledger.verified ? 'verified' : 'tampered'}
        </span>
      </PanelTitle>
      <div className="chain">
        {ledger.entries.map((e) => (
          <div className="entry" key={e.seq}>
            <div className="seq mono">{e.seq.toString().padStart(2, '0')}</div>
            <div className="body">
              <code className="kind">{e.kind}</code>
              <pre>{String(JSON.stringify(e.payload)).slice(0, 180)}</pre>
              <div className="muted mono hashlink">
                {truncate(e.hash, 26)} <span className="arrow">→</span> prev {truncate(e.prevHash, 12)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="muted">
        Append-only hash chain — each entry commits to the one before it. Current root{' '}
        <code>{truncate(ledger.root, 20)}</code>. Try rewriting any entry on disk and the root stops
        verifying.
      </p>
    </section>
  );
}

function PolicyPanel({ state }: { state: State }) {
  return (
    <section className="panel">
      <PanelTitle>Standing policy</PanelTitle>
      <div className="rules">
        {RULE_MEANING.map((r) => (
          <div className="rule" key={r.key}>
            <div className="rule-label">
              <span className="muted">{r.label}</span>
              <span className="why">{r.why}</span>
            </div>
            <div className="rule-value mono">{r.fmt(state.policy)}</div>
          </div>
        ))}
      </div>
      <p className="muted">
        rules pinned as <code>policyHash</code>{' '}
        <code title={state.policyHash}>{truncate(state.policyHash, 20)}</code> · every deal carries it, and
        the auditor checks the deal against it.
      </p>
    </section>
  );
}
