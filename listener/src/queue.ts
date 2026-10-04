/**
 * Durable job queue + authenticated forwarder to the skim keeper.
 *
 * Replaces the old in-memory array whose drain() was never called. Jobs are
 * persisted as JSONL under listener/data/ so a restart does not lose work, and the
 * queue actually forwards to the keeper (`POST ${KEEPER_URL}/sweep`).
 *
 * Forwarding contract (frozen v1):
 *   headers: content-type + `authorization: Bearer ${KEEPER_SHARED_SECRET}`
 *   body:    { user, mint, outputAmount, decimals, signature }
 *   200 {"status":"swept"|"skipped"} and 409 {"status":"duplicate"} => success.
 *   5xx and network/timeout errors => retry with exponential backoff up to
 *   FORWARD_RETRIES, then dead-letter. Other 4xx => permanent dead-letter.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';

export interface SkimJob {
  user: string;
  mint: string;
  outputAmount: string;
  decimals: number;
  signature: string;
}

export interface QueueRecord {
  id: string;
  job: SkimJob;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
}

export interface DrainResult {
  forwarded: number;
  retried: number;
  deadLettered: number;
  remaining: number;
  /** Jobs skipped because their backoff window has not elapsed yet. */
  deferred: number;
}

export type ForwardOutcome = 'success' | 'retry' | 'dead';

export interface QueueLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface QueueOptions {
  dataDir: string;
  keeperUrl: string;
  keeperSharedSecret: string;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: QueueLogger;
  idFactory?: () => string;
}

const consoleLogger: QueueLogger = {
  info: (m, meta) => console.log(`[queue] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[queue] ${m}`, meta ?? ''),
};

/** Resolve listener/data/ regardless of whether we run from src, dist or dist-test. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (typeof env.LISTENER_DATA_DIR === 'string' && env.LISTENER_DATA_DIR) return env.LISTENER_DATA_DIR;
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return path.join(dir, 'data');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), 'data');
}

function parseRecords(raw: string, logger: QueueLogger): QueueRecord[] {
  const records: QueueRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as QueueRecord;
      if (record && record.job && typeof record.id === 'string') records.push(record);
    } catch {
      // A torn line (crash mid-append) is skipped. The job itself was never acked.
      logger.warn('skipping corrupt queue line');
    }
  }
  return records;
}

export class DurableQueue {
  private readonly dataDir: string;
  private readonly queueFile: string;
  private readonly deadLetterFile: string;
  private readonly keeperUrl: string;
  private readonly keeperSharedSecret: string;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logger: QueueLogger;
  private readonly idFactory: () => string;
  private pending: Promise<DrainResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(opts: QueueOptions) {
    this.dataDir = opts.dataDir;
    this.queueFile = path.join(opts.dataDir, 'queue.jsonl');
    this.deadLetterFile = path.join(opts.dataDir, 'dead-letter.jsonl');
    this.keeperUrl = opts.keeperUrl.replace(/\/+$/, '');
    this.keeperSharedSecret = opts.keeperSharedSecret;
    this.retries = Math.max(1, opts.retries ?? 5);
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? consoleLogger;
    this.idFactory =
      opts.idFactory ?? (() => `${this.now()}-${(this.seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  private readRecords(): QueueRecord[] {
    try {
      return parseRecords(fs.readFileSync(this.queueFile, 'utf8'), this.logger);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return [];
      throw e;
    }
  }

  private writeRecords(records: QueueRecord[]): void {
    this.ensureDir();
    const body = records.map((r) => JSON.stringify(r)).join('\n');
    const tmp = `${this.queueFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body.length > 0 ? `${body}\n` : '');
    fs.renameSync(tmp, this.queueFile);
  }

  private appendDeadLetter(record: QueueRecord, reason: string): void {
    this.ensureDir();
    const entry = { ...record, deadLetteredAt: this.now(), reason };
    fs.appendFileSync(this.deadLetterFile, `${JSON.stringify(entry)}\n`);
    this.logger.warn('job dead-lettered', { id: record.id, signature: record.job?.signature, reason });
  }

  /** Persist a job durably (append-only, crash-safe). */
  async enqueue(job: SkimJob): Promise<void> {
    const record: QueueRecord = {
      id: this.idFactory(),
      job,
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.now(),
    };
    this.ensureDir();
    fs.appendFileSync(this.queueFile, `${JSON.stringify(record)}\n`);
  }

  /** Number of jobs currently persisted (pending + deferred). */
  size(): number {
    return this.readRecords().length;
  }

  /** Read the persisted records (exposed for tests/ops). */
  peek(): QueueRecord[] {
    return this.readRecords();
  }

  /** Read dead-lettered records (exposed for tests/ops). */
  deadLetters(): any[] {
    try {
      return fs
        .readFileSync(this.deadLetterFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    } catch (e: any) {
      if (e?.code === 'ENOENT') return [];
      throw e;
    }
  }

  /** Process the queue once, forwarding every due job. Coalesces concurrent calls. */
  async drain(): Promise<DrainResult> {
    if (this.pending) return this.pending;
    const run = this.runDrain();
    this.pending = run;
    try {
      return await run;
    } finally {
      this.pending = null;
    }
  }

  private async runDrain(): Promise<DrainResult> {
    const now = this.now();
    const records = this.readRecords();
    const survivors: QueueRecord[] = [];
    let forwarded = 0;
    let retried = 0;
    let deadLettered = 0;
    let deferred = 0;

    for (const record of records) {
      if (record.nextAttemptAt > now) {
        survivors.push(record);
        deferred++;
        continue;
      }
      const outcome = await this.forward(record.job);
      if (outcome.status === 'success') {
        forwarded++;
        continue;
      }
      record.attempts += 1;
      record.lastError = outcome.error;
      if (outcome.status === 'retry' && record.attempts < this.retries) {
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (record.attempts - 1));
        record.nextAttemptAt = now + delay;
        survivors.push(record);
        retried++;
      } else {
        this.appendDeadLetter(record, outcome.error ?? outcome.status);
        deadLettered++;
      }
    }

    this.writeRecords(survivors);
    return { forwarded, retried, deadLettered, remaining: survivors.length, deferred };
  }

  private async forward(job: SkimJob): Promise<{ status: ForwardOutcome; error?: string }> {
    if (!this.keeperUrl) return { status: 'dead', error: 'KEEPER_URL not configured' };
    const url = `${this.keeperUrl}/sweep`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.keeperSharedSecret}`,
        },
        body: JSON.stringify({
          user: job.user,
          mint: job.mint,
          outputAmount: job.outputAmount,
          decimals: job.decimals,
          signature: job.signature,
        }),
        signal: controller.signal,
      });
      if (res.status === 409) return { status: 'success' }; // duplicate == already handled
      if (res.ok) return { status: 'success' };
      if (res.status >= 500) return { status: 'retry', error: `keeper ${res.status}` };
      return { status: 'dead', error: `keeper ${res.status}` };
    } catch (e: any) {
      const message = e?.name === 'AbortError' ? 'keeper request timed out' : String(e?.message ?? e);
      return { status: 'retry', error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Recover persisted work immediately, then drain on an interval. */
  start(intervalMs = 1000): void {
    void this.drain().catch((e) => this.logger.warn('initial drain failed', { error: String(e?.message ?? e) }));
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.drain().catch((e) => this.logger.warn('drain failed', { error: String(e?.message ?? e) }));
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Build a queue from env (frozen contract names) with optional overrides. */
export function createQueue(opts: Partial<QueueOptions> = {}): DurableQueue {
  const cfg = loadConfig();
  return new DurableQueue({
    dataDir: opts.dataDir ?? cfg.dataDir ?? resolveDataDir(),
    keeperUrl: opts.keeperUrl ?? cfg.keeperUrl,
    keeperSharedSecret: opts.keeperSharedSecret ?? cfg.keeperSharedSecret,
    retries: opts.retries ?? cfg.forwardRetries,
    ...opts,
  });
}

let defaultQueue: DurableQueue | null = null;

/** Process-wide queue bound to env config. */
export function getDefaultQueue(): DurableQueue {
  if (!defaultQueue) defaultQueue = createQueue();
  return defaultQueue;
}

/** @deprecated use a DurableQueue instance; kept for call-site compatibility. */
export async function enqueue(job: SkimJob): Promise<void> {
  return getDefaultQueue().enqueue(job);
}

/** @deprecated use a DurableQueue instance; kept for call-site compatibility. */
export async function drain(): Promise<DrainResult> {
  return getDefaultQueue().drain();
}
