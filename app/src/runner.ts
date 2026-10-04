/**
 * The single-process v1 runner.
 *
 * One Node process, one public port. Composes the three working pieces:
 *   - the Telegram bot        (grammy long-polling, no inbound URL)
 *   - the listener webhook     (mounted on the one public port)
 *   - the keeper engine        (called IN-PROCESS via the durable SweepQueue)
 *
 * `buildRunner(config)` wires the real dependencies; tests inject fakes so the
 * whole composition can be exercised with no network and no live Telegram token.
 */
import * as http from 'http';
import express, { type Request, type Response } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import type { AppConfig } from './config';
import {
  loadKeeper,
  loadListener,
  loadTelegramBot,
  type DeadLetterLike,
  type DedupeLike,
  type KeeperModules,
  type SweepInput,
  type SweepResult,
} from './deps';
import { KeeperBridgeQueue } from './queue-bridge';
import { mountSignRoutes } from './sign';

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** A startable/stoppable bot. The real one wraps the grammy Bot. */
export interface BotLike {
  name?: string;
  start(): void;
  stop(): Promise<void> | void;
  isRunning(): boolean;
  /** Optional — send a plain-text Telegram message. Never throws (swallows errors). */
  sendMessage?(chatId: string, text: string): Promise<void>;
}

/** The complete set of injected parts. Absent => real wiring is built. */
export interface RunnerDeps {
  /** The keeper engine callback wired into the durable SweepQueue. */
  engine: (input: SweepInput, dedupeHeld: boolean) => Promise<SweepResult>;
  bot: BotLike;
  keeperPubkey: string;
  keeperBalance: () => Promise<number>;
  dedupe: DedupeLike;
  deadletter: DeadLetterLike;
}

export interface HealthPayload {
  ok: boolean;
  service: string;
  uptimeMs: number;
  port: number;
  bot: { running: boolean; name: string };
  listener: { queueDepth: number; outstanding: number; pending: number; running: number };
  keeper: {
    pubkey: string;
    solLamports: number;
    lowFunds: boolean;
    rpc: string;
    envReady: boolean;
    missingEnv: string[];
  };
}

export interface Runner {
  app: express.Express;
  config: AppConfig;
  keeperPubkey: string;
  keeperBalance: () => Promise<number>;
  bot: BotLike;
  queueStats(): { outstanding: number; pending: number; running: number };
  health(): Promise<HealthPayload>;
  listen(port?: number): Promise<{ port: number }>;
  startBot(): void;
  start(): Promise<{ port: number }>;
  shutdown(timeoutMs?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Real dependencies (built only when none are injected)
// ---------------------------------------------------------------------------

function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    if (u.search) u.search = '?<redacted>';
    return u.toString();
  } catch {
    return '<invalid-url>';
  }
}

function createRealBot(log: Logger): BotLike {
  let running = false;
  let bot: ReturnType<typeof loadTelegramBot> | null = null;
  return {
    name: 'telegram',
    start(): void {
      if (running) return;
      bot = loadTelegramBot();
      running = true;
      bot
        .start({ onStart: (info: { username?: string }) => log.info(`telegram bot online as @${info?.username ?? 'unknown'}`) })
        .catch((err: unknown) => {
          running = false;
          log.warn('telegram bot polling stopped', { error: String((err as Error)?.message ?? err) });
        });
    },
    async stop(): Promise<void> {
      running = false;
      if (bot) {
        try {
          await bot.stop();
        } catch {
          /* already stopped */
        }
      }
    },
    isRunning: () => running,
    async sendMessage(chatId: string, text: string): Promise<void> {
      try {
        if (bot && bot.api) {
          await bot.api.sendMessage(chatId, text);
        }
      } catch (err) {
        log.warn('telegram sendMessage failed', { chatId, error: String((err as Error)?.message ?? err) });
      }
    },
  };
}

function resolvePublicUrl(): string | null {
  const pub = process.env.PUBLIC_URL;
  if (pub && pub.trim()) return pub.trim().replace(/\/$/, '');
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (domain && domain.trim()) return `https://${domain.trim()}`;
  return null;
}

/** Build the real keeper engine, bot and balance reader from config. */
export function buildDefaultDeps(config: AppConfig, log: Logger): RunnerDeps {
  const keeper: KeeperModules = loadKeeper();
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const keeperKeypair = keeper.loadKeypairFromFile(config.keeperKeypairPath);
  const keeperPubkey = keeperKeypair.publicKey.toBase58();

  // The bot builds each user's bounded approval for THIS delegate.
  if (!process.env.KEEPER_DELEGATE) process.env.KEEPER_DELEGATE = keeperPubkey;

  const dedupe = new keeper.FileDedupe(config.dedupePath, config.dedupeTtlMs);
  const deadletter = new keeper.FileDeadLetter(config.deadLetterPath);
  const resolveUser = keeper.makeUserResolver(config.userStorePath);
  const readMintOwner = keeper.makeMintProgramReader(connection, config.tokenProgramCacheMs);

  const engine = (input: SweepInput, dedupeHeld: boolean): Promise<SweepResult> => {
    const mint = new PublicKey(input.mint);
    return keeper
      .processSkim({
        connection,
        keeper: keeperKeypair,
        treasury: config.treasury,
        user: new PublicKey(input.authority),
        mint,
        outputAmount: BigInt(input.outputAmount),
        decimals: input.decimals,
        swapSignature: input.signature,
        resolveUser,
        dedupe,
        deadletter,
        dedupeHeld,
        minKeeperLamports: config.minKeeperLamports,
        computeUnitLimit: config.computeUnitLimit,
        computeUnitPriceMicroLamports: config.priorityFeeMicroLamports,
        resolveTokenProgram: config.detectTokenProgram
          ? async () => {
              const owner = await readMintOwner(mint);
              return owner === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
            }
          : undefined,
      })
      .then((result) => {
        log.info('keeper engine (in-process) result', {
          signature: input.signature,
          user: input.authority,
          status: result.status,
          ...(result.status === 'swept' ? { skim: result.skim, fee: result.fee } : {}),
          ...(result.status === 'skipped' ? { reason: result.reason } : {}),
        });
        return result;
      });
  };

  let cachedSol = 0;
  let cachedAt = 0;
  const keeperBalance = async (): Promise<number> => {
    const now = Date.now();
    if (now - cachedAt < 5000) return cachedSol;
    cachedSol = await connection.getBalance(keeperKeypair.publicKey, 'confirmed');
    cachedAt = now;
    return cachedSol;
  };

  log.info('keeper engine wired in-process', {
    keeper: keeperPubkey,
    treasury: config.treasury.toBase58(),
    rpc: redactRpc(config.rpcUrl),
  });

  return { engine, bot: createRealBot(log), keeperPubkey, keeperBalance, dedupe, deadletter };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface RunnerOptions {
  deps?: RunnerDeps;
  logger?: Logger;
}

export function buildRunner(config: AppConfig, options: RunnerOptions = {}): Runner {
  const log: Logger = options.logger ?? console;
  const deps: RunnerDeps = options.deps ?? buildDefaultDeps(config, log);
  const keeper: KeeperModules = loadKeeper();

  // The durable keeper queue IS the listener's queue: enqueue -> submit
  // in-process, dedupe + persistence + retry owned by the keeper queue.
  // Resolve users for new-token prompts (re-reads store on every call — same as keeper).
  const resolveUserForPrompt = keeper.makeUserResolver(config.userStorePath);
  const promptThrottle = new Map<string, number>(); // `${authority}:${mint}` → sent-at ms

  // Wrap the injected engine to fire Telegram prompts on 'skipped/no-delegate'.
  const engineWithPrompt = async (input: SweepInput, dedupeHeld: boolean): Promise<SweepResult> => {
    const result = await deps.engine(input, dedupeHeld);
    if (result.status === 'skipped' && (result as { status: 'skipped'; reason: string }).reason === 'no-delegate') {
      const publicUrl = config.publicUrl;
      if (publicUrl) {
        const throttleKey = `${input.authority}:${input.mint}`;
        const lastSent = promptThrottle.get(throttleKey) ?? 0;
        if (Date.now() - lastSent >= 24 * 60 * 60 * 1000) {
          promptThrottle.set(throttleKey, Date.now());
          try {
            const user = resolveUserForPrompt(input.authority);
            if (user && user.chatId) {
              const link = `${publicUrl}/sign?a=${encodeURIComponent(input.authority)}&m=${encodeURIComponent(input.mint)}`;
              const text =
                `A new token appeared in your trade: ${input.mint.slice(0, 8)}…\n\n` +
                `Approve the keeper for this token so future trades are saved:\n${link}\n\n` +
                `(Future trades of this token will be saved once approved. ` +
                `The skim for this first trade is not retroactively swept.)`;
              await deps.bot.sendMessage?.(user.chatId, text);
            }
          } catch (err) {
            log.warn('new-token prompt failed', { error: String((err as Error)?.message ?? err) });
          }
        }
      } else {
        log.info('new-token prompt skipped: publicUrl not configured', {
          user: input.authority, mint: input.mint,
        });
      }
    }
    return result;
  };

  const keeperQueue = new keeper.SweepQueue({
    process: engineWithPrompt,
    dedupe: deps.dedupe,
    deadletter: deps.deadletter,
    persistPath: config.queuePath,
    maxAttempts: config.maxAttempts,
    backoffBaseMs: config.backoffBaseMs,
    backoffMaxMs: config.backoffMaxMs,
    ratePerSec: config.sweepsPerSecond,
    burst: config.sweepBurst,
  });

  const bridge = new KeeperBridgeQueue(keeperQueue, log);

  // The listener's existing express app, driven by our in-process bridge queue.
  const listenerApp = loadListener().createApp({
    secret: config.webhookSecret,
    queue: bridge,
    logger: (message: string, meta?: Record<string, unknown>) => log.info(message, meta),
  }) as express.Express;

  const startedAt = Date.now();

  const buildHealth = async (): Promise<HealthPayload> => {
    let solLamports = 0;
    let rpc = 'ok';
    try {
      solLamports = await deps.keeperBalance();
    } catch {
      rpc = 'error';
    }
    const stats = keeperQueue.stats();
    let botRunning = false;
    try {
      botRunning = deps.bot.isRunning();
    } catch {
      botRunning = false;
    }
    return {
      ok: true,
      service: 'skim-v1-single-process',
      uptimeMs: Date.now() - startedAt,
      port: config.webhookPort,
      bot: { running: botRunning, name: deps.bot.name ?? 'telegram' },
      listener: {
        queueDepth: bridge.outstandingCount() + stats.pending + stats.running,
        outstanding: bridge.outstandingCount(),
        pending: stats.pending,
        running: stats.running,
      },
      keeper: {
        pubkey: deps.keeperPubkey,
        solLamports,
        lowFunds: solLamports < config.minKeeperLamports,
        rpc,
        envReady: config.missingEnv.length === 0,
        missingEnv: config.missingEnv,
      },
    };
  };

  // Aggregated app: our /health wins (registered before the listener mount so
  // the listener's own /health cannot shadow it); everything else flows to the
  // listener, which serves POST /webhook/tx.
  const app = express();
  app.disable('x-powered-by');

  // Sign routes (/sign, /api/approvals, /api/rpc) — mounted before the listener.
  const signConnection = new Connection(config.rpcUrl, 'confirmed');
  mountSignRoutes(app, config, signConnection, deps.keeperPubkey);

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      res.status(200).json(await buildHealth());
    } catch (err) {
      res.status(500).json({ ok: false, error: String((err as Error)?.message ?? err) });
    }
  });
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, service: 'skim-v1-single-process', health: '/health' });
  });
  app.use(listenerApp);

  let server: http.Server | null = null;

  const queueStats = () => {
    const s = keeperQueue.stats();
    return { outstanding: bridge.outstandingCount(), pending: s.pending, running: s.running };
  };

  const listen = async (port = config.webhookPort): Promise<{ port: number }> => {
    if (server) throw new Error('runner is already listening');
    const s = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(port, () => {
        s.off('error', reject);
        resolve();
      });
    });
    server = s;
    const addr = s.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    return { port: actual };
  };

  const startBot = (): void => {
    try {
      deps.bot.start();
    } catch (err) {
      log.warn('bot failed to start', { error: String((err as Error)?.message ?? err) });
    }
  };

  const shutdown = async (timeoutMs = 15_000): Promise<void> => {
    log.info('shutting down — stopping bot and flushing queue');
    try {
      await deps.bot.stop();
    } catch (err) {
      log.warn('bot stop failed', { error: String((err as Error)?.message ?? err) });
    }
    if (server) {
      const s = server;
      server = null;
      // Stop accepting new work, then release idle keep-alive sockets so an
      // in-flight webhook (which awaits its drain) can still finish.
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
        s.closeIdleConnections?.();
      });
    }
    // Jobs are persisted by the SweepQueue on every state change, so even a
    // hard stop loses nothing — this waits (bounded) for in-flight work to finish.
    const deadline = Date.now() + timeoutMs;
    while (keeperQueue.stats().pending + keeperQueue.stats().running > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const left = keeperQueue.stats();
    if (left.pending + left.running > 0) {
      log.warn('shutdown timeout: remaining jobs are persisted and resume on next boot', {
        pending: left.pending,
        running: left.running,
      });
    }
    await keeperQueue.close();
    log.info('shutdown complete', { pendingLeft: left.pending, runningLeft: left.running });
  };

  return {
    app,
    config,
    keeperPubkey: deps.keeperPubkey,
    keeperBalance: deps.keeperBalance,
    bot: deps.bot,
    queueStats,
    health: buildHealth,
    listen,
    startBot,
    start: async () => {
      const { port } = await listen();
      startBot();
      return { port };
    },
    shutdown,
  };
}
