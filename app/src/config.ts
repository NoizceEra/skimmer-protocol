/**
 * Single env surface for the v1 single-process runner.
 *
 * ONE `.env` file (app/.env) covers all three components — the Telegram bot,
 * the listener webhook and the keeper engine. `loadConfig()` fails fast on the
 * first missing/invalid REQUIRED var and names it in the error message.
 *
 * Everything here is read from the process env passed in (default process.env),
 * so tests can drive it without touching the real environment.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';

export const DEFAULT_PROTOCOL_FEE_BPS = 40;
export const DEFAULT_WEBHOOK_PORT = 4000;
export const DEFAULT_PROGRAM_ID = '2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp';
export const DEFAULT_MIN_KEEPER_LAMPORTS = 5_000_000;
export const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1_000n;
export const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Vars that MUST be present or the process refuses to boot. Chosen so a valid
 * boot can actually serve: a bot token, an RPC to talk to, a treasury to pay,
 * a keeper key to sign with, and a webhook secret to authenticate callers.
 * Everything else has a safe, documented default.
 */
export const REQUIRED_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'RPC_URL',
  'TREASURY',
  'KEEPER_KEYPAIR',
  'WEBHOOK_SECRET',
] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  // --- listener (public surface) ---
  webhookPort: number;
  webhookSecret: string;

  // --- bot ---
  telegramBotToken: string;
  rpcUrl: string;
  programId: string;
  protocolFeeBps: number;

  // --- keeper ---
  treasury: PublicKey;
  keeperKeypairPath: string;
  userStorePath: string;
  minKeeperLamports: number;
  computeUnitLimit: number;
  priorityFeeMicroLamports: bigint;
  detectTokenProgram: boolean;
  tokenProgramCacheMs: number;

  // --- durable state (dedupe / queue / dead-letter) ---
  stateDir: string;
  dedupePath: string;
  deadLetterPath: string;
  queuePath: string;
  dedupeTtlMs: number;

  // --- retry / rate ---
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  sweepsPerSecond: number;
  sweepBurst: number;

  // --- web signing flow ---
  /** Public base URL for /sign links in Telegram prompts. Null = prompts skipped. */
  publicUrl: string | null;

  // --- bookkeeping for /health ---
  repoRoot: string;
  /** REQUIRED vars absent from the env (empty on a successful load). */
  missingEnv: string[];
}

/** Walk up from `startDir` to the repo root (a dir holding keeper/ + listener/). */
export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    if (
      fs.existsSync(path.join(dir, 'keeper')) &&
      fs.existsSync(path.join(dir, 'listener')) &&
      fs.existsSync(path.join(dir, 'programs'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError(`could not locate repo root (keeper/ + listener/ + programs/) from ${startDir}`);
}

function present(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = env[key];
  return typeof raw === 'string' && raw.trim() !== '';
}

/** REQUIRED vars that are missing from the given env. */
export function missingRequired(env: NodeJS.ProcessEnv): string[] {
  return REQUIRED_VARS.filter((key) => !present(env, key));
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (!present(env, key)) throw new ConfigError(`missing required env var ${key}`);
  return (raw as string).trim();
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number, got "${raw}"`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Load and validate the whole env surface. Throws ConfigError naming the first
 * problem (and every missing REQUIRED var) so startup fails loudly.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missingEnv = missingRequired(env);
  if (missingEnv.length > 0) {
    throw new ConfigError(`missing required env var(s): ${missingEnv.join(', ')}`);
  }

  const repoRoot = findRepoRoot(__dirname);

  const treasuryRaw = required(env, 'TREASURY');
  let treasury: PublicKey;
  try {
    treasury = new PublicKey(treasuryRaw);
  } catch {
    throw new ConfigError(`TREASURY is not a valid base58 pubkey: "${treasuryRaw}"`);
  }

  const port = num(env, 'WEBHOOK_PORT', DEFAULT_WEBHOOK_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`WEBHOOK_PORT out of range: ${port}`);
  }

  const userStorePath = present(env, 'USER_STORE_PATH')
    ? path.resolve(required(env, 'USER_STORE_PATH'))
    : path.join(repoRoot, 'data', 'users.json');

  // Durable state lives under repo/data (already gitignored) by default.
  const stateDir = present(env, 'KEEPER_STATE_DIR')
    ? path.resolve(required(env, 'KEEPER_STATE_DIR'))
    : path.join(repoRoot, 'data', 'v1-state');

  const minKeeperLamports = num(env, 'KEEPER_MIN_LAMPORTS', DEFAULT_MIN_KEEPER_LAMPORTS);
  if (minKeeperLamports < 0) throw new ConfigError('KEEPER_MIN_LAMPORTS must be >= 0');

  const computeUnitLimit = num(env, 'COMPUTE_UNIT_LIMIT', DEFAULT_COMPUTE_UNIT_LIMIT);
  if (computeUnitLimit <= 0) throw new ConfigError('COMPUTE_UNIT_LIMIT must be > 0');

  let priorityFeeMicroLamports = DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  if (present(env, 'PRIORITY_FEE_MICRO_LAMPORTS')) {
    try {
      priorityFeeMicroLamports = BigInt(required(env, 'PRIORITY_FEE_MICRO_LAMPORTS'));
    } catch {
      throw new ConfigError(`PRIORITY_FEE_MICRO_LAMPORTS must be an integer, got "${env.PRIORITY_FEE_MICRO_LAMPORTS}"`);
    }
    if (priorityFeeMicroLamports < 0n) throw new ConfigError('PRIORITY_FEE_MICRO_LAMPORTS must be >= 0');
  }

  const dedupeHours = num(env, 'DEDUPE_TTL_HOURS', 24);
  if (dedupeHours <= 0) throw new ConfigError('DEDUPE_TTL_HOURS must be > 0');

  const maxAttempts = num(env, 'SWEEP_MAX_ATTEMPTS', 4);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ConfigError('SWEEP_MAX_ATTEMPTS must be an integer >= 1');
  }
  const backoffBaseMs = num(env, 'SWEEP_BACKOFF_BASE_MS', 250);
  const backoffMaxMs = num(env, 'SWEEP_BACKOFF_MAX_MS', 4_000);
  if (backoffBaseMs <= 0 || backoffMaxMs < backoffBaseMs) {
    throw new ConfigError('SWEEP_BACKOFF_BASE_MS / SWEEP_BACKOFF_MAX_MS are inconsistent');
  }
  const sweepsPerSecond = num(env, 'SWEEP_RATE_PER_SEC', 5);
  const sweepBurst = num(env, 'SWEEP_BURST', 5);
  if (sweepsPerSecond <= 0 || sweepBurst < 1) {
    throw new ConfigError('SWEEP_RATE_PER_SEC > 0 and SWEEP_BURST >= 1 required');
  }

  // Public URL: explicit env > Railway auto-domain > null
  let publicUrl: string | null = null;
  if (present(env, 'PUBLIC_URL')) {
    publicUrl = required(env, 'PUBLIC_URL').trim().replace(/\/$/, '');
  } else if (present(env, 'RAILWAY_PUBLIC_DOMAIN')) {
    publicUrl = `https://${required(env, 'RAILWAY_PUBLIC_DOMAIN').trim()}`;
  }

  return {
    webhookPort: port,
    webhookSecret: required(env, 'WEBHOOK_SECRET'),
    telegramBotToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    rpcUrl: required(env, 'RPC_URL'),
    programId: present(env, 'PROGRAM_ID') ? required(env, 'PROGRAM_ID') : DEFAULT_PROGRAM_ID,
    protocolFeeBps: num(env, 'PROTOCOL_FEE_BPS', DEFAULT_PROTOCOL_FEE_BPS),
    treasury,
    keeperKeypairPath: path.resolve(required(env, 'KEEPER_KEYPAIR')),
    userStorePath,
    minKeeperLamports,
    computeUnitLimit,
    priorityFeeMicroLamports,
    detectTokenProgram: bool(env, 'DETECT_TOKEN_PROGRAM', true),
    tokenProgramCacheMs: num(env, 'TOKEN_PROGRAM_CACHE_MS', 5 * 60 * 1000),
    stateDir,
    dedupePath: path.join(stateDir, 'dedupe.json'),
    deadLetterPath: path.join(stateDir, 'deadletter.json'),
    queuePath: path.join(stateDir, 'queue.json'),
    dedupeTtlMs: Math.round(dedupeHours * 60 * 60 * 1000),
    maxAttempts,
    backoffBaseMs,
    backoffMaxMs,
    sweepsPerSecond,
    sweepBurst,
    publicUrl,
    repoRoot,
    missingEnv,
  };
}
