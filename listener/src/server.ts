/**
 * skim-listener HTTP surface.
 *
 *  GET  /health      -> 200 { ok, service }
 *  POST /webhook/tx  -> authenticated (Authorization: Bearer ${WEBHOOK_SECRET}) and
 *                       rate-limited. Accepts a JSON array of Helius enhanced-tx
 *                       events, parses genuine swap outputs, durably enqueues them and
 *                       forwards them to the keeper. A bad element never takes the
 *                       process down.
 */

import crypto from 'crypto';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import dotenv from 'dotenv';

import { parseSwapEvent } from './parser';
import { loadConfig, type AppConfig } from './config';
import { createQueue, getDefaultQueue, type DrainResult, type SkimJob } from './queue';

// Load listener/.env first (works from src/ and dist/), then fall back to cwd.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

export interface QueueLike {
  enqueue(job: SkimJob): Promise<void>;
  drain(): Promise<DrainResult>;
}

export interface RateLimitOptions {
  perIp: number;
  global: number;
  windowMs: number;
}

/** Sliding-window limiter: per-IP plus a global ceiling. */
export class RateLimiter {
  private readonly hitsByIp = new Map<string, number[]>();
  private readonly global: number[] = [];

  constructor(private readonly opts: RateLimitOptions) {}

  private prune(bucket: number[], now: number): void {
    const cutoff = now - this.opts.windowMs;
    while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
  }

  private retryAfter(bucket: number[], now: number): number {
    if (bucket.length === 0) return 1;
    const seconds = Math.ceil((bucket[0] + this.opts.windowMs - now) / 1000);
    return Math.max(1, seconds);
  }

  check(ip: string, now: number = Date.now()): { allowed: boolean; retryAfter: number } {
    this.prune(this.global, now);
    const bucket = this.hitsByIp.get(ip) ?? [];
    this.prune(bucket, now);

    if (this.global.length >= this.opts.global) {
      return { allowed: false, retryAfter: this.retryAfter(this.global, now) };
    }
    if (bucket.length >= this.opts.perIp) {
      return { allowed: false, retryAfter: this.retryAfter(bucket, now) };
    }

    bucket.push(now);
    this.hitsByIp.set(ip, bucket);
    this.global.push(now);
    return { allowed: true, retryAfter: 0 };
  }
}

export function bearerFrom(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/** Constant-time comparison of two secrets (hash both so lengths cannot leak). */
export function safeEqualSecret(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

export interface AppOptions {
  secret: string;
  queue: QueueLike;
  rateLimiter?: RateLimiter;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export function createApp(opts: AppOptions) {
  const app = express();
  const log = opts.logger ?? (() => {});
  const limiter = opts.rateLimiter ?? new RateLimiter({ perIp: 60, global: 600, windowMs: 60_000 });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'skim-listener' });
  });

  const rateLimit = (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const result = limiter.check(ip);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      res.status(429).json({ error: 'rate limit exceeded', retryAfter: result.retryAfter });
      return;
    }
    next();
  };

  const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    if (!opts.secret) {
      log('webhook rejected: WEBHOOK_SECRET not configured');
      res.status(503).json({ error: 'server misconfigured: WEBHOOK_SECRET is not set' });
      return;
    }
    const token = bearerFrom(req.header('authorization'));
    if (!token || !safeEqualSecret(token, opts.secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  app.post('/webhook/tx', rateLimit, authenticate, async (req: Request, res: Response) => {
    const events = req.body;
    if (!Array.isArray(events)) {
      res.status(400).json({ error: 'expected a JSON array of events' });
      return;
    }

    let queued = 0;
    let rejected = 0;
    for (const event of events) {
      try {
        const parsed = parseSwapEvent(event, { log });
        if (!parsed) {
          rejected++;
          continue;
        }
        await opts.queue.enqueue({
          user: parsed.user,
          mint: parsed.mint,
          outputAmount: parsed.outputAmount,
          decimals: parsed.decimals,
          signature: parsed.signature,
        });
        queued++;
      } catch (e: any) {
        // Never let one bad element take the process (or the batch) down.
        rejected++;
        log('failed to process event', { error: String(e?.message ?? e) });
      }
    }

    let forwarded = 0;
    try {
      const result = await opts.queue.drain();
      forwarded = result.forwarded;
    } catch (e: any) {
      log('drain failed after enqueue', { error: String(e?.message ?? e) });
    }

    res.status(200).json({ queued, forwarded, rejected });
  });

  // JSON body-parse errors and any unexpected route error.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = err?.status && Number.isInteger(err.status) ? err.status : 400;
    res.status(status).json({ error: String(err?.message ?? 'bad request') });
  });

  return app;
}

/** Build the app from env config with an optional dependency override (tests). */
export function createAppFromEnv(
  config: AppConfig = loadConfig(),
  deps: { queue?: QueueLike; rateLimiter?: RateLimiter } = {},
) {
  const queue = deps.queue ?? getDefaultQueue();
  const rateLimiter =
    deps.rateLimiter ??
    new RateLimiter({
      perIp: config.rateLimitPerIp,
      global: config.rateLimitGlobal,
      windowMs: config.rateWindowMs,
    });
  return createApp({ secret: config.webhookSecret, queue, rateLimiter });
}

const app = createAppFromEnv();

if (require.main === module) {
  const config = loadConfig();
  const queue = getDefaultQueue();
  queue.start(1000);
  app.listen(config.webhookPort, () => {
    console.log(`skim-listener on ${config.webhookPort}`);
  });
}

export default app;
