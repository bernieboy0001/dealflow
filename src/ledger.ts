import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LedgerEntry {
  seq: number;
  kind: string;
  payload: unknown;
  prevHash: string;
  hash: string;
  at: string;
}

/**
 * Append-only evidence ledger. Each entry commits to the previous hash, so the
 * chain is tamper-evident: verify(root) fails if any entry was rewritten.
 */
export class Ledger {
  private entries: LedgerEntry[] = [];

  constructor(
    private readonly file: string,
    seed?: LedgerEntry[],
  ) {
    this.entries = seed ?? [];
  }

  static load(file: string): Ledger {
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      return new Ledger(file, JSON.parse(raw) as LedgerEntry[]);
    }
    return new Ledger(file);
  }

  get seq(): number {
    return this.entries.length;
  }

  append(kind: string, payload: unknown): LedgerEntry {
    const prev = this.entries[this.entries.length - 1];
    const seq = this.entries.length + 1;
    const body = JSON.stringify({ seq, kind, payload });
    const hash = createHash('sha256')
      .update(body)
      .update(prev ? prev.hash : 'genesis')
      .digest('hex');
    const entry: LedgerEntry = {
      seq,
      kind,
      payload,
      prevHash: prev ? prev.hash : 'genesis',
      hash,
      at: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.flush();
    return entry;
  }

  all(): LedgerEntry[] {
    return [...this.entries];
  }

  byKind(kind: string): LedgerEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  /** returns the glued-in hash of the last entry — the chain's current root */
  root(): string {
    const last = this.entries[this.entries.length - 1];
    return last ? last.hash : 'genesis';
  }

  /** recompute the chain from the first entry; throws if the stored chain is inconsistent */
  verify(): boolean {
    let prev = 'genesis';
    for (const e of this.entries) {
      const body = JSON.stringify({ seq: e.seq, kind: e.kind, payload: e.payload });
      const expect = createHash('sha256').update(body).update(prev).digest('hex');
      if (expect !== e.hash) return false;
      if (e.prevHash !== prev) return false;
      prev = e.hash;
    }
    return true;
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
    } catch {
      // read-only filesystem (Vercel serverless) — state survives only in memory
    }
  }
}

export function localPath(...parts: string[]): string {
  return join(process.cwd(), '.local', ...parts);
}
