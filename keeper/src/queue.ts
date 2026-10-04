/**
 * Persistent, token-bucketed retry queue.
 *
 * Sits in FRONT of processSkim and gives the engine a real caller:
 *   - at most one in-flight sweep transaction per user (per-user serialisation)
 *   - a token bucket so we never stampede the RPC
 *   - exponential backoff on transient failures with a bounded attempt count
 *   - jobs persisted to disk so a restart resumes instead of losing work
 *   - the dedupe claim is owned by the queue for the whole life of a job, so a
 *     retry can re-enter processSkim without being seen as a duplicate.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DedupeLike } from './dedupe';
import type { DeadLetterLike } from './deadletter';
import type { SweepResult } from './engine';

export interface SweepInput {
  authority: string;
  mint: string;
  outputAmount: string;
  decimals: number;
  signature: string;
}

export type QueueOutcome =
  | SweepResult
  | { status: 'error'; error: string; attempts: number };

export interface QueueJob {
  id: string;
  input: SweepInput;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
}

export interface SweepQueueOptions {
  /** The engine call. `dedupeHeld=true` means the queue already holds the claim. */
  process: (input: SweepInput, dedupeHeld: boolean) => Promise<SweepResult>;
  dedupe?: DedupeLike;
  deadletter?: DeadLetterLike;
  persistPath?: string;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  ratePerSec?: number;
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  tryConsume(at: number = this.now()): boolean {
    const elapsed = (at - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec);
      this.last = at;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export class SweepQueue {
  private readonly dedupe?: DedupeLike;
  private readonly deadletter?: DeadLetterLike;
  private readonly persistPath?: string;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly bucket: TokenBucket;
  private pending: QueueJob[] = [];
  private readonly runningJobs = new Map<string, QueueJob>();
  private readonly activeUsers = new Set<string>();
  private readonly resolvers = new Map<string, (outcome: QueueOutcome) => void>();
  private loop: Promise<void> | null = null;
  private stopped = false;
  private sequence = 0;

  constructor(private readonly options: SweepQueueOptions) {
    this.dedupe = options.dedupe;
    this.deadletter = options.deadletter;
    this.persistPath = options.persistPath;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.backoffBaseMs = options.backoffBaseMs ?? 250;
    this.backoffMaxMs = options.backoffMaxMs ?? 4000;
    this.burst = Math.max(1, options.burst ?? 5);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.bucket = new TokenBucket(options.ratePerSec ?? 5, this.burst, this.now);
    this.loadPersisted();
  }

  private loadPersisted(): void {
    if (!this.persistPath) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.persistPath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const job of parsed as QueueJob[]) {
        if (!job || typeof job !== 'object' || !job.input) continue;
        // A job whose signature is already processed is dropped (duplicate).
        if (this.dedupe && !this.dedupe.claim(job.input.signature)) continue;
        this.pending.push({
          id: typeof job.id === 'string' ? job.id : this.nextId(job.input),
          input: job.input,
          attempts: Number(job.attempts) || 0,
          nextAttemptAt: Number(job.nextAttemptAt) || 0,
          createdAt: Number(job.createdAt) || this.now(),
          lastError: job.lastError,
        });
      }
      if (this.pending.length > 0) this.ensureLoop();
    } catch {
      // corrupt queue file: start clean
    }
  }

  private nextId(input: SweepInput): string {
    this.sequence += 1;
    return `${input.signature}#${this.sequence}`;
  }

  private persist(): void {
    if (!this.persistPath) return;
    const all = [...this.pending, ...this.runningJobs.values()];
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, this.persistPath);
    } catch {
      // persistence is best-effort; the in-memory queue still functions
    }
  }

  stats(): { pending: number; running: number } {
    return { pending: this.pending.length, running: this.runningJobs.size };
  }

  /** Submit a sweep. Resolves on the terminal outcome for this signature. */
  submit(input: SweepInput): Promise<QueueOutcome> {
    if (this.dedupe && !this.dedupe.claim(input.signature)) {
      return Promise.resolve({ status: 'duplicate' });
    }
    const job: QueueJob = {
      id: this.nextId(input),
      input,
      attempts: 0,
      nextAttemptAt: this.now(),
      createdAt: this.now(),
    };
    const promise = new Promise<QueueOutcome>((resolve) => {
      this.resolvers.set(job.id, resolve);
    });
    this.pending.push(job);
    this.persist();
    this.ensureLoop();
    return promise;
  }

  private ensureLoop(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.run().finally(() => {
      this.loop = null;
      if (!this.stopped && (this.pending.length > 0 || this.runningJobs.size > 0)) {
        this.ensureLoop();
      }
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const current = this.now();
      let startedThisPass = false;

      for (const job of [...this.pending]) {
        if (this.runningJobs.size >= this.burst) break;
        if (this.activeUsers.has(job.input.authority)) continue;
        if (job.nextAttemptAt > current) continue;
        if (!this.bucket.tryConsume(current)) break;
        this.pending = this.pending.filter((j) => j.id !== job.id);
        this.startJob(job);
        startedThisPass = true;
      }

      if (this.pending.length === 0 && this.runningJobs.size === 0) return;

      if (this.runningJobs.size > 0) {
        await Promise.race(this.runningJobs.values());
        continue;
      }

      if (!startedThisPass) {
        const earliest = Math.min(...this.pending.map((j) => j.nextAttemptAt));
        const wait = Math.min(Math.max(1, earliest - this.now()), 1000);
        await this.sleep(wait);
      }
    }
  }

  private startJob(job: QueueJob): void {
    this.activeUsers.add(job.input.authority);
    this.runningJobs.set(job.id, job);
    this.persist();
    const promise = this.attempt(job)
      .catch(() => undefined)
      .finally(() => {
        this.runningJobs.delete(job.id);
        this.activeUsers.delete(job.input.authority);
      });
    // Fire-and-forget: run() watches runningJobs for completion.
    void promise;
  }

  private async attempt(job: QueueJob): Promise<void> {
    try {
      const result = await this.options.process(job.input, true);
      this.finish(job, result);
    } catch (err) {
      job.attempts += 1;
      job.lastError = (err as Error).message;
      if (job.attempts >= this.maxAttempts) {
        this.deadletter?.add({
          signature: job.input.signature,
          user: job.input.authority,
          mint: job.input.mint,
          outputAmount: job.input.outputAmount,
          reason: 'rpc-failed',
          attempts: job.attempts,
          at: this.now(),
          detail: job.lastError,
        });
        this.finish(job, { status: 'error', error: job.lastError, attempts: job.attempts });
      } else {
        const delay = Math.min(
          this.backoffMaxMs,
          this.backoffBaseMs * 2 ** (job.attempts - 1),
        );
        job.nextAttemptAt = this.now() + delay;
        this.pending.push(job);
        this.persist();
      }
    }
  }

  private finish(job: QueueJob, outcome: QueueOutcome): void {
    const resolve = this.resolvers.get(job.id);
    if (resolve) {
      this.resolvers.delete(job.id);
      resolve(outcome);
    }
    this.persist();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.loop) await this.loop.catch(() => undefined);
  }
}
