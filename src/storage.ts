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

/** Minimal Upstash Redis client — the command endpoint: POST {url} with a JSON
 *  command array, returns [{ result, error? }]. (The /set/{key} route
 *  double-wraps values; this form round-trips raw strings faithfully.) */
class UpstashRedisStore implements StateStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async command<T>(cmd: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`durable-store ${String(cmd[0])} ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: string }[];
    if (!j[0]) throw new Error(`durable-store ${String(cmd[0])}: empty reply`);
    if (j[0].error) throw new Error(`durable-store ${String(cmd[0])}: ${j[0].error}`);
    return j[0].result as T;
  }

  async get(key: string): Promise<string | null> {
    return (await this.command<string | null>(['GET', key])) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.command<string>(['SET', key, value]);
  }
}
