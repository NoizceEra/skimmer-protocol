/**
 * Persistent dedupe store.
 *
 * The contract: never double-sweep the same swap signature, and a keeper
 * restart MUST NOT forget what it already processed. A 24h TTL bounds the file.
 *
 * Writes are synchronous so the check-and-claim is atomic within a process
 * (no await between read and write), which is enough for the single-process
 * keeper the queue also serialises per user.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface DedupeLike {
  claim(signature: string): boolean;
  release(signature: string): void;
  has(signature: string): boolean;
  size(): number;
}

export class InMemoryDedupe implements DedupeLike {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  claim(signature: string): boolean {
    const current = this.now();
    const expiry = this.seen.get(signature);
    if (expiry !== undefined && expiry > current) return false;
    this.seen.set(signature, current + this.ttlMs);
    return true;
  }

  release(signature: string): void {
    this.seen.delete(signature);
  }

  has(signature: string): boolean {
    const expiry = this.seen.get(signature);
    return expiry !== undefined && expiry > this.now();
  }

  size(): number {
    return this.seen.size;
  }
}

interface DedupeFile {
  [signature: string]: number;
}

/** File-backed dedupe with a 24h (configurable) expiry. */
export class FileDedupe implements DedupeLike {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as DedupeFile;
      if (parsed === null || typeof parsed !== 'object') return;
      const current = this.now();
      for (const [sig, expiry] of Object.entries(parsed)) {
        if (typeof expiry === 'number' && expiry > current) this.seen.set(sig, expiry);
      }
      // Drop expired entries from disk on next write.
      if (Object.keys(parsed).length !== this.seen.size) this.persist();
    } catch {
      // Corrupt dedupe file: start clean rather than crash.
    }
  }

  private persist(): void {
    const out: DedupeFile = {};
    for (const [sig, expiry] of this.seen) out[sig] = expiry;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // A failed persistence must not break the sweep; the in-memory map
      // still guards this process. Log-free by design (no logger dependency).
    }
  }

  claim(signature: string): boolean {
    const current = this.now();
    const expiry = this.seen.get(signature);
    if (expiry !== undefined && expiry > current) return false;
    this.seen.set(signature, current + this.ttlMs);
    this.persist();
    return true;
  }

  release(signature: string): void {
    if (this.seen.delete(signature)) this.persist();
  }

  has(signature: string): boolean {
    const expiry = this.seen.get(signature);
    return expiry !== undefined && expiry > this.now();
  }

  size(): number {
    return this.seen.size;
  }
}
