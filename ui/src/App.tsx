import { useEffect, useState, useCallback } from 'react';

type Side = 'buy' | 'sell';
type DealStatus = 'proposing' | 'proposed' | 'approved' | 'executing' | 'executed' | 'verified' | 'settled' | 'rejected' | 'cancelled' | 'failed';

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

interface State {
  principal: string;
  worker: string;
  alive: boolean;
  policyHash: string;
  policy: { allowedSymbols: string[]; maxNotionalUsd: number; maxSlippageBps: number; maxTotalFeeBps: number; roundTrip: boolean };
  ledgerRoot: string;
  deals: { id: string; job: string; status: DealStatus; fee: string; orders: number; createdAt: string }[];
}

interface LedgerView {
  root: string;
  verified: boolean;
  entries: { seq: number; kind: string; payload: unknown; prevHash: string; hash: string; at: string }[];
}

function fmtUsd(atomic: string): string {
  return `$${(Number(atomic) / 1e6).toFixed(2)}`;
}

function fmtQty(q: string): string {
  const whole = Number(q) / 1e6;
  return whole > 0.01 ? whole.toFixed(4) : whole.toExponential(2);
}

const MICRO = 1e6;
function fmtPrice(micro: string): string {
  return `$${(Number(micro) / MICRO).toFixed(4)}`;
}

const STATUS_COLOR: Record<DealStatus, string> = {
  proposing: '#a3aab5',
  proposed: '#8ab4f8',
  approved: '#7dd3fc',
  executing: '#9f8ff0',
  executed: '#c3ffb0',
  verified: '#4caf50',
  settled: '#66bb6a',
  rejected: '#ef5350',
  cancelled: '#90a4ae',
  failed: '#ef5350',
};

const NEXT_ACTION: Record<DealStatus, { label: string; endpoint: string } | null> = {
  proposing: null,
  proposed: { label: 'approve (sign intent)', endpoint: 'approve' },
  approved: { label: 'execute + audit', endpoint: 'execute' },
  executing: null,
  executed: null,
  verified: { label: 'settle (x402 payout)', endpoint: 'settle' },
  settled: null,
  rejected: null,
  cancelled: null,
  failed: null,
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState({ BTC: 0.2, ETH: 0.4, SOL: 0.4 });
  const [busy, setBusy] = useState(false);

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
    return () => clearInterval(t);
  }, [refresh]);

  async function propose() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/propose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job: 'rebalance to weights', targets }),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function drive(dealId: string, endpoint: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dealId }) });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    setBusy(true);
    try {
      await api('/api/stop', { method: 'POST' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <main className="shell">
        <p className="muted">connecting to broker…</p>
        {error && <pre className="err">{error}</pre>}
      </main>
    );
  }

  return (
    <main className="shell">
      <header>
        <div>
          <h1>The Broker <span className="dim">· dealflow</span></h1>
          <p className="muted">Pay-per-outcome agents on Agent OS. Work is a priced deal — provably delivered, signed by you, paid only when it checks out.</p>
        </div>
        <div className={`liveness ${state.alive ? 'green' : 'red'}`}>{state.alive ? 'alive' : 'stopped'}</div>
      </header>

      {error && <pre className="err">⚠ {error}</pre>}

      <section className="cards">
        <div className="card">
          <h2>Principal</h2>
          <code>{state.principal}</code>
          <p className="muted">signs every deal intent (EIP-712)</p>
        </div>
        <div className="card">
          <h2>Worker</h2>
          <code>{state.worker}</code>
          <p className="muted">paid via x402 only after the auditor passes the deal</p>
        </div>
        <div className="card">
          <h2>Policy pinned</h2>
          <code title={state.policyHash}>{state.policyHash.slice(0, 18)}…</code>
          <p className="muted">
            allow {state.policy.allowedSymbols.join(', ')} · ≤ ${state.policy.maxNotionalUsd} notional · ≤ {state.policy.maxSlippageBps}bps slip · {state.policy.roundTrip ? 'no round-trips' : 'round-trips ok'}
          </p>
        </div>
        <div className="card">
          <h2>Ledger root</h2>
          <code title={state.ledgerRoot}>{state.ledgerRoot.slice(0, 18)}…</code>
          <p className="muted">hash-chain root · {ledger ? (ledger.verified ? 'intact' : 'TAMPERED') : '…'}</p>
        </div>
      </section>

      <section className="panel">
        <h2>Start a deal</h2>
        <div className="row wrap">
          {(['BTC', 'ETH', 'SOL'] as const).map((s) => (
            <label key={s} className="target">
              {s}{' '}
              <input
                type="number"
                step="0.05"
                min="0"
                max="0.6"
                value={targets[s]}
                onChange={(e) => setTargets((t) => ({ ...t, [s]: Number(e.target.value) }))}
              />
            </label>
          ))}
          <button onClick={propose} disabled={busy || !state.alive} className="primary">
            {busy ? 'working…' : 'propose'}
          </button>
          <button onClick={stopAll} disabled={!state.alive} className="danger">
            emergency stop
          </button>
        </div>
        <p className="muted">target portfolio weights (must sum ≤ 1.0). One button-press per step — the human stays in the loop.</p>
      </section>

      <section className="panel">
        <h2>Deals</h2>
        {state.deals.length === 0 && <p className="muted">no deals yet — propose one above</p>}
        {state.deals.map((d) => (
          <DealRow key={d.id} deal={d} onDrive={drive} busy={busy} />
        ))}
      </section>

      {ledger && (
        <section className="panel">
          <h2>Evidence ledger <span className={`badge ${ledger.verified ? 'green' : 'red'}`}>{ledger.verified ? 'verified' : 'tampered'}</span></h2>
          <div className="chain">
            {ledger.entries.map((e) => (
              <div className="entry" key={e.seq}>
                <div className="seq">{e.seq.toString().padStart(2, '0')}</div>
                <div className="body">
                  <code className="kind">{e.kind}</code>
                  <pre>{JSON.stringify(e.payload).slice(0, 160)}{JSON.stringify(e.payload).length > 160 ? '…' : ''}</pre>
                  <div className="muted mono">{e.hash.slice(0, 26)}… <span className="arrow">→</span> prev {e.prevHash.slice(0, 10)}…</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function DealRow({ deal, onDrive, busy }: { deal: State['deals'][number]; onDrive: (id: string, ep: string) => void; busy: boolean }) {
  const full: { deal: Deal } | null = useLoadedDeal(deal.id);
  const action = NEXT_ACTION[deal.status];
  return (
    <div className="deal">
      <div className="deal-head">
        <span className="mono dim">{deal.id.slice(0, 8)}</span>
        <strong>{deal.job}</strong>
        <span className={`status`} style={{ color: STATUS_COLOR[deal.status] }}>
          {deal.status}
        </span>
        <span className="muted">{fmtUsd(deal.fee)} worker fee · {deal.orders} orders</span>
        {action && (
          <button onClick={() => onDrive(deal.id, action.endpoint)} disabled={busy} className="primary small">
            {action.label}
          </button>
        )}
      </div>
      {full && (
        <div className="deal-detail">
          {full.deal.summaryLines.length > 0 && <pre className="summary">{full.deal.summaryLines.join('\n')}</pre>}
          <table>
            <thead>
              <tr><th>symbol</th><th>side</th><th>qty</th><th>limit</th><th>slip</th><th>receipt</th></tr>
            </thead>
            <tbody>
              {full.deal.orders.map((o) => {
                const r = full.deal.receipts?.find((x) => x.clientOrderId === o.clientOrderId);
                return (
                  <tr key={o.clientOrderId}>
                    <td>{o.symbol}</td>
                    <td className={o.side === 'buy' ? 'buy' : 'sell'}>{o.side}</td>
                    <td>{fmtQty(o.quantity)}</td>
                    <td>{fmtPrice(o.limitPriceMicro)}</td>
                    <td>{o.maxSlippageBps}bps</td>
                    <td>{r ? <span className={r.status === 'filled' ? 'green' : 'red'}>{r.status}</span> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {full.deal.audit && (
            <div className={`audit ${full.deal.audit.passed ? 'green' : 'red'}`}>
              <strong>audit: {full.deal.audit.passed ? 'PASS' : 'FAIL'}</strong>
              <span className="muted">{full.deal.audit.checks.map((c) => (c.ok ? '✓' : '✗') + ' ' + c.name).join(' · ')}</span>
              <span className="mono">by {full.deal.audit.signedBy.slice(0, 10)}…</span>
            </div>
          )}
          {full.deal.payment && (
            <div className="audit green">
              <strong>paid via {full.deal.payment.rail}</strong>
              <span className="mono">{full.deal.payment.txHash.slice(0, 20)}…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function useLoadedDeal(id: string): { deal: Deal } | null {
  const [loaded, setLoaded] = useState<{ deal: Deal } | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ deal: Deal }>(`/api/deals/${id}`)
      .then((d) => alive && setLoaded(d))
      .catch(() => alive && setLoaded(null));
    return () => {
      alive = false;
    };
  }, [id]);
  return loaded;
}