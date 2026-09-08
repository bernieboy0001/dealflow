import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable broker state. On a dev box this is plain files under .local/; on
 * Vercel the read-only filesystem makes those writes no-ops, which is exactly
 * why a deployed broker "forgot" everything on every cold start. When a
 * Key/Value REST store is configured (Vercel KV / Upstash Redis), all three
 * state pieces (ledger, subaccount snapshot, deals) go through it instead, so
 * every function instance boots from the same durable truth.
 */
export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Writes are best-effort fire-and-forget; drain keeps restart honest. */
const inflight = new Set<Promise<unknown>>();
export function drainStore(): Promise<void> {
  return Promise.all([...inflight]).then(() => undefined);
}

export const STATE_KEYS = {
  ledger: 'dealflow:ledger',
  account: 'dealflow:account',
  deals: 'dealflow:deals',
} as const;

/** Read from the store when configured, otherwise from the local file. */
export async function loadText(
  store: StateStore | undefined,
  key: string,
  file: string,
): Promise<string | null> {
  if (store) return store.get(key);
  try {
    if (existsSync(file)) return readFileSync(file, 'utf8');
  } catch {
    // unreadable local snapshot — start fresh rather than crash the broker
  }
  return null;
}

/** Write to the store when configured, otherwise to the local file. */
export function saveText(store: StateStore | undefined, key: string, file: string, value: string): void {
  if (store) {
    const p = store.set(key, value).catch((e) => console.error('[dealflow] durable-state write failed', e));
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  } catch {
    // read-only filesystem (Vercel serverless) — state stays in memory only
  }
}

/** Vercel KV provisions an Upstash Redis and sets UPSTASH_REDIS_REST_* / KV_REST_API_*. */
export function durableStoreFromEnv(): StateStore | undefined {
  const url =
    process.env.DEALFLOW_KV_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.DEALFLOW_KV_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? new UpstashRedisStore(url, token) : undefined;
}

/** Minimal Upstash Redis REST client — GET /get/:key, POST /set/:key. */
class UpstashRedisStore implements StateStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async get(key: string): Promise<string | null> {
    const res = await fetch(`${this.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`durable-store GET ${res.status}`);
    const j = (await res.json()) as { result?: string | null };
    return j.result ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const res = await fetch(`${this.url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`durable-store SET ${res.status}`);
  }
}
