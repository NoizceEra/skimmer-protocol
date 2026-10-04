/**
 * Skim keeper HTTP entry point (FROZEN INTERFACE CONTRACT v1).
 *
 *   GET  /health -> 200 {"ok":true,"service":"skim-keeper","keeper":"<pubkey>","solLamports":<n>}
 *   POST /sweep   Authorization: Bearer <KEEPER_SHARED_SECRET>
 *        200 {"status":"swept","signature":..,"skim":..,"fee":..}
 *        200 {"status":"skipped","reason":..}
 *        401 {"error":"unauthorized"}
 *        400 {"error":"<reason>"}
 *        409 {"status":"duplicate"}
 *        503 {"error":"rpc-unavailable",...}   (bounded retries exhausted)
 */
import * as crypto from 'crypto';
import * as path from 'path';
import express, { Request, Response, Express } from 'express';
import dotenv from 'dotenv';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ConfigError, KeeperConfig, loadConfig, loadKeypairFromFile } from './config';
import { makeUserResolver, ResolvedUser } from './store';
import { FileDedupe } from './dedupe';
import { FileDeadLetter } from './deadletter';
import { SweepInput, SweepQueue } from './queue';
import { SweepResult, makeMintProgramReader, processSkim } from './engine';

export interface AppContext {
  config: KeeperConfig;
  keeper: Keypair;
  queue: SweepQueue;
  resolveUser: (authority: string) => ResolvedUser | null;
  getKeeperSolLamports: () => Promise<number>;
  now?: () => number;
  startedAt?: number;
}

/** Constant-time string comparison (no early-exit on the first mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn a real compare so the length is not a timing oracle, then fail.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

interface ParsedSweep {
  input?: SweepInput;
  error?: string;
}

export function parseSweepBody(body: unknown): ParsedSweep {
  if (body === null || typeof body !== 'object') return { error: 'invalid-body' };
  const b = body as Record<string, unknown>;
  const user = typeof b.user === 'string' ? b.user.trim() : '';
  const mint = typeof b.mint === 'string' ? b.mint.trim() : '';
  const outputAmount = typeof b.outputAmount === 'string' ? b.outputAmount.trim() : '';
  const signature = typeof b.signature === 'string' ? b.signature.trim() : '';
  const decimals = typeof b.decimals === 'number' ? b.decimals : Number(b.decimals);

  if (!user) return { error: 'missing-user' };
  if (!mint) return { error: 'missing-mint' };
  if (!outputAmount) return { error: 'missing-outputAmount' };
  if (!signature) return { error: 'missing-signature' };
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return { error: 'bad-decimals' };
  }
  try {
    new PublicKey(user);
  } catch {
    return { error: 'bad-user' };
  }
  try {
    new PublicKey(mint);
  } catch {
    return { error: 'bad-mint' };
  }
  if (!/^\d+$/.test(outputAmount)) return { error: 'bad-outputAmount' };

  return {
    input: {
      authority: user,
      mint,
      outputAmount: BigInt(outputAmount).toString(),
      decimals,
      signature,
    },
  };
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', async (_req: Request, res: Response) => {
    let solLamports = 0;
    let rpc = 'ok';
    try {
      solLamports = await ctx.getKeeperSolLamports();
    } catch {
      rpc = 'error';
    }
    const now = ctx.now ?? Date.now;
    res.status(200).json({
      ok: true,
      service: 'skim-keeper',
      keeper: ctx.keeper.publicKey.toBase58(),
      solLamports,
      minSolLamports: ctx.config.minKeeperLamports,
      lowFunds: solLamports < ctx.config.minKeeperLamports,
      rpc,
      queue: ctx.queue.stats(),
      uptimeMs: now() - (ctx.startedAt ?? now()),
    });
  });

  app.post('/sweep', async (req: Request, res: Response) => {
    const auth = req.header('authorization') ?? '';
    const prefix = 'Bearer ';
    if (
      !auth.startsWith(prefix) ||
      !safeEqual(auth.slice(prefix.length), ctx.config.sharedSecret)
    ) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = parseSweepBody(req.body);
    if (!parsed.input) return res.status(400).json({ error: parsed.error });
    const input = parsed.input;

    // Optional strict allowlist (opt-in; off by default so it cannot surprise
    // callers who coded against the frozen response set).
    if (ctx.config.mintAllowlistEnforce) {
      const user = ctx.resolveUser(input.authority);
      if (user && user.approvedMints.length > 0 && !user.approvedMints.includes(input.mint)) {
        return res.status(400).json({ error: 'mint-not-approved' });
      }
    }

    let outcome: SweepResult | { status: 'error'; error: string; attempts: number };
    try {
      outcome = await ctx.queue.submit(input);
    } catch (err) {
      return res.status(500).json({ error: 'engine-failure', detail: (err as Error).message });
    }

    if (outcome.status === 'duplicate') {
      return res.status(409).json({ status: 'duplicate' });
    }
    if (outcome.status === 'swept') {
      return res.status(200).json({
        status: 'swept',
        signature: outcome.signature,
        skim: outcome.skim,
        fee: outcome.fee,
      });
    }
    if (outcome.status === 'skipped') {
      return res.status(200).json({ status: 'skipped', reason: outcome.reason });
    }
    return res.status(503).json({
      error: 'rpc-unavailable',
      signature: input.signature,
      attempts: outcome.attempts,
      detail: outcome.error,
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    if (u.search) u.search = '?<redacted>';
    return u.toString();
  } catch {
    return '<invalid-url>';
  }
}

async function main(): Promise<void> {
  // Load keeper/.env explicitly (dotenv from the keeper package root).
  dotenv.config({ path: path.join(__dirname, '..', '.env') });

  let config: KeeperConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    const detail = err instanceof ConfigError ? err.message : (err as Error).message;
    console.error(`[skim-keeper] FATAL configuration error: ${detail}`);
    console.error(
      '[skim-keeper] Required env: RPC_URL, KEEPER_KEYPAIR, TREASURY, KEEPER_SHARED_SECRET ' +
        '(see keeper/.env.example).',
    );
    process.exit(1);
  }

  let keeper: Keypair;
  try {
    keeper = loadKeypairFromFile(config.keeperKeypairPath);
  } catch (err) {
    console.error(`[skim-keeper] FATAL keeper keypair error: ${(err as Error).message}`);
    process.exit(1);
  }

  const connection = new Connection(config.rpcUrl, 'confirmed');
  const dedupe = new FileDedupe(config.dedupePath, config.dedupeTtlMs);
  const deadletter = new FileDeadLetter(config.deadLetterPath);
  const resolveUser = makeUserResolver(config.userStorePath);
  const readMintOwner = makeMintProgramReader(connection, config.tokenProgramCacheMs);

  const queue = new SweepQueue({
    process: (input, dedupeHeld) => {
      const mint = new PublicKey(input.mint);
      return processSkim({
        connection,
        keeper,
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
              return owner === TOKEN_2022_PROGRAM_ID.toBase58()
                ? TOKEN_2022_PROGRAM_ID
                : TOKEN_PROGRAM_ID;
            }
          : undefined,
      });
    },
    dedupe,
    deadletter,
    persistPath: config.queuePath,
    maxAttempts: config.maxAttempts,
    backoffBaseMs: config.backoffBaseMs,
    backoffMaxMs: config.backoffMaxMs,
    ratePerSec: config.sweepsPerSecond,
    burst: config.sweepBurst,
  });

  let cachedSol = 0;
  let cachedAt = 0;
  const getKeeperSolLamports = async (): Promise<number> => {
    const now = Date.now();
    if (now - cachedAt < 5000) return cachedSol;
    cachedSol = await connection.getBalance(keeper.publicKey, 'confirmed');
    cachedAt = now;
    return cachedSol;
  };

  const app = createApp({
    config,
    keeper,
    queue,
    resolveUser,
    getKeeperSolLamports,
    startedAt: Date.now(),
  });

  app.listen(config.port, () => {
    console.log(`[skim-keeper] listening on :${config.port}`);
    console.log(`[skim-keeper] user store: ${config.userStorePath}`);
    console.log(`[skim-keeper] state dir : ${config.stateDir}`);
  });

  console.log(
    `[skim-keeper] keeper=${keeper.publicKey.toBase58()} treasury=${config.treasury.toBase58()} rpc=${redactRpc(config.rpcUrl)}`,
  );
  try {
    const sol = await getKeeperSolLamports();
    console.log(`[skim-keeper] starting SOL balance: ${sol} lamports`);
    if (sol < config.minKeeperLamports) {
      console.warn(
        `[skim-keeper] WARNING: keeper SOL ${sol} < floor ${config.minKeeperLamports}; ` +
          'sweeps will return no-keeper-funds until funded.',
      );
    }
  } catch (err) {
    console.warn(`[skim-keeper] could not read keeper SOL balance: ${(err as Error).message}`);
  }
}

if (require.main === module) {
  void main();
}

export default createApp;
