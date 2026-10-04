/**
 * In-process bridge: the listener's enqueue/drain contract over the keeper's
 * durable SweepQueue.
 *
 * The listener webhook calls `enqueue(job)` for each parsed swap, then
 * `drain()`. This bridge forwards each job straight into the keeper's
 * `SweepQueue.submit()` — calling the engine in-process, with NO HTTP hop —
 * and awaits the terminal outcomes on drain.
 *
 * Durability is the keeper queue's: `submit()` synchronously persists
 * pending+running jobs to `queue.json` and owns the dedupe claim for the life of
 * the job, so a job survives a restart and is retried on transient failure
 * (exponential backoff -> dead-letter). Nothing here reimplements that.
 */
import type { DedupeLike, SweepInput, SweepQueueLike, SweepResult } from './deps';

export interface SkimJob {
  user: string;
  mint: string;
  outputAmount: string;
  decimals: number;
  signature: string;
}

export interface DrainResult {
  forwarded: number;
  retried: number;
  deadLettered: number;
  remaining: number;
  deferred: number;
}

export interface BridgeLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** The listener's QueueLike contract (enqueue + drain). */
export interface QueueLike {
  enqueue(job: SkimJob): Promise<void>;
  drain(): Promise<DrainResult>;
}

export class KeeperBridgeQueue implements QueueLike {
  private outstanding: Array<Promise<SweepResult>> = [];

  constructor(
    private readonly queue: SweepQueueLike,
    private readonly log: BridgeLogger = { info: () => {}, warn: () => {} },
  ) {}

  private toInput(job: SkimJob): SweepInput {
    return {
      authority: job.user,
      mint: job.mint,
      outputAmount: job.outputAmount,
      decimals: job.decimals,
      signature: job.signature,
    };
  }

  /**
   * Submit immediately so the job is durable at the earliest point (SweepQueue
   * persists synchronously) and starts running without waiting for drain().
   */
  async enqueue(job: SkimJob): Promise<void> {
    const input = this.toInput(job);
    const promise = Promise.resolve(this.queue.submit(input)).catch(
      (err: unknown): SweepResult => ({ status: 'error', error: String((err as Error)?.message ?? err) }),
    );
    this.outstanding.push(promise);
    // Bound memory if drain() is never called: the job is already persisted and
    // running, so dropping the promise handle loses nothing but the outcome read.
    if (this.outstanding.length > 1000) {
      this.outstanding.splice(0, this.outstanding.length - 1000);
    }
    this.log.info('enqueued sweep job', { signature: job.signature, user: job.user });
  }

  outstandingCount(): number {
    return this.outstanding.length;
  }

  /** Await every job submitted since the last drain and summarise outcomes. */
  async drain(): Promise<DrainResult> {
    const batch = this.outstanding;
    this.outstanding = [];
    let forwarded = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const promise of batch) {
      const outcome = await promise;
      const status = outcome?.status;
      if (status === 'swept' || status === 'skipped' || status === 'duplicate') {
        // A duplicate (already handled / already claimed) is a success, matching
        // the listener's 409-as-success contract.
        forwarded += 1;
      } else {
        deadLettered += 1;
      }
    }

    const stats = this.queue.stats();
    return {
      forwarded,
      retried,
      deadLettered,
      remaining: stats.pending + stats.running,
      deferred: 0,
    };
  }
}

/** Convenience for tests / callers that need a no-op dedupe. */
export function permissiveDedupe(): DedupeLike {
  return {
    claim: () => true,
    release: () => {},
    has: () => false,
    size: () => 0,
  };
}
