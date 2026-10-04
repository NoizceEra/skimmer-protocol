/**
 * Keeper configuration loader (FROZEN INTERFACE CONTRACT v1).
 *
 * Required env (fail fast at startup):
 *   RPC_URL, KEEPER_KEYPAIR, TREASURY, KEEPER_SHARED_SECRET
 * Optional:
 *   KEEPER_PORT (default 5001), USER_STORE_PATH (default <repo-root>/data/users.json)
 *
 * Anything that changes the money or the network path is configurable with a
 * documented, safe default — never compiled in silently.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';

export const DEFAULT_MIN_KEEPER_LAMPORTS = 5_000_000; // 0.005 SOL gas floor
export const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1_000n; // ~0.0000002 SOL per CU at 1e3
export const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface KeeperConfig {
  port: number;
  rpcUrl: string;
  keeperKeypairPath: string;
  treasury: PublicKey;
  sharedSecret: string;
  userStorePath: string;
  stateDir: string;
  dedupePath: string;
  deadLetterPath: string;
  queuePath: string;
  /** SOL balance floor (lamports) under which we refuse to spam failed txs. */
  minKeeperLamports: number;
  /** Priority fee, micro-lamports per compute unit. */
  priorityFeeMicroLamports: bigint;
  computeUnitLimit: number;
  dedupeTtlMs: number;
  /** Retry queue: bounded attempts + exponential backoff. */
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Token bucket for sweep submissions. */
  sweepsPerSecond: number;
  sweepBurst: number;
  /** Optional strict mint allowlist enforcement from the user store. */
  mintAllowlistEnforce: boolean;
  /** Auto-detect Token-2022 mints from their owning program. */
  detectTokenProgram: boolean;
  /** Mint program read cache TTL. */
  tokenProgramCacheMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i += 1) m.set(BASE58_ALPHABET[i], i);
  return m;
})();

/** Dependency-free base58 decode (no bs58 dependency required). */
export function base58Decode(input: string): Uint8Array {
  const s = input.trim();
  if (s.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of s) {
    const val = BASE58_MAP.get(ch);
    if (val === undefined) throw new Error(`invalid base58 character "${ch}"`);
    let carry = val;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < s.length && s[k] === '1'; k += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/** Accept either a JSON array of bytes or a base58-encoded secret key. */
export function loadKeypairFromString(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ConfigError('keypair content is empty');
  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch (err) {
      throw new ConfigError(`keypair JSON array is not valid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(arr)) throw new ConfigError('keypair JSON is not an array');
    const bytes = Uint8Array.from(arr.map((n) => Number(n)));
    return keypairFromBytes(bytes);
  }
  return keypairFromBytes(base58Decode(trimmed));
}

export function loadKeypairFromFile(filePath: string): Keypair {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `cannot read KEEPER_KEYPAIR at "${filePath}": ${(err as Error).message}`,
    );
  }
  return loadKeypairFromString(raw);
}

function keypairFromBytes(bytes: Uint8Array): Keypair {
  if (bytes.length !== 64) {
    throw new ConfigError(
      `keeper secret key must be 64 bytes, got ${bytes.length} (expected a 64-byte ed25519 keypair)`,
    );
  }
  try {
    return Keypair.fromSecretKey(bytes);
  } catch (err) {
    throw new ConfigError(`invalid keeper secret key: ${(err as Error).message}`);
  }
}

/** Walk up from `startDir` to locate the repo root (has keeper/ + programs/). */
export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, 'keeper')) &&
      fs.existsSync(path.join(dir, 'programs'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '..', '..');
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number, got "${raw}"`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(`missing required env var ${key}`);
  }
  return raw.trim();
}

/**
 * Load and validate configuration. Throws ConfigError with an actionable
 * message on the FIRST missing/invalid required value (fail fast).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const rpcUrl = required(env, 'RPC_URL');
  const keeperKeypairPath = required(env, 'KEEPER_KEYPAIR');
  const sharedSecret = required(env, 'KEEPER_SHARED_SECRET');

  const treasuryRaw = required(env, 'TREASURY');
  let treasury: PublicKey;
  try {
    treasury = new PublicKey(treasuryRaw);
  } catch {
    throw new ConfigError(`TREASURY is not a valid base58 pubkey: "${treasuryRaw}"`);
  }

  const repoRoot = findRepoRoot(__dirname);
  const userStorePath =
    env.USER_STORE_PATH && env.USER_STORE_PATH.trim() !== ''
      ? path.resolve(env.USER_STORE_PATH.trim())
      : path.join(repoRoot, 'data', 'users.json');

  const stateDir =
    env.KEEPER_STATE_DIR && env.KEEPER_STATE_DIR.trim() !== ''
      ? path.resolve(env.KEEPER_STATE_DIR.trim())
      : path.join(__dirname, '..', '.state');

  const port = num(env, 'KEEPER_PORT', num(env, 'PORT', 5001));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`KEEPER_PORT out of range: ${port}`);
  }

  const minKeeperLamports = num(env, 'KEEPER_MIN_LAMPORTS', DEFAULT_MIN_KEEPER_LAMPORTS);
  if (minKeeperLamports < 0) throw new ConfigError('KEEPER_MIN_LAMPORTS must be >= 0');

  const computeUnitLimit = num(env, 'COMPUTE_UNIT_LIMIT', DEFAULT_COMPUTE_UNIT_LIMIT);
  if (computeUnitLimit <= 0) throw new ConfigError('COMPUTE_UNIT_LIMIT must be > 0');

  const feeRaw = env.PRIORITY_FEE_MICRO_LAMPORTS;
  let priorityFeeMicroLamports = DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  if (feeRaw !== undefined && feeRaw.trim() !== '') {
    try {
      priorityFeeMicroLamports = BigInt(feeRaw.trim());
    } catch {
      throw new ConfigError(`PRIORITY_FEE_MICRO_LAMPORTS must be an integer, got "${feeRaw}"`);
    }
    if (priorityFeeMicroLamports < 0n) {
      throw new ConfigError('PRIORITY_FEE_MICRO_LAMPORTS must be >= 0');
    }
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

  return {
    port,
    rpcUrl,
    keeperKeypairPath,
    treasury,
    sharedSecret,
    userStorePath,
    stateDir,
    dedupePath: path.join(stateDir, 'dedupe.json'),
    deadLetterPath: path.join(stateDir, 'deadletter.json'),
    queuePath: path.join(stateDir, 'queue.json'),
    minKeeperLamports,
    priorityFeeMicroLamports,
    computeUnitLimit,
    dedupeTtlMs: Math.round(dedupeHours * 60 * 60 * 1000),
    maxAttempts,
    backoffBaseMs,
    backoffMaxMs,
    sweepsPerSecond,
    sweepBurst,
    mintAllowlistEnforce: bool(env, 'MINT_ALLOWLIST_ENFORCE', false),
    detectTokenProgram: bool(env, 'DETECT_TOKEN_PROGRAM', true),
    tokenProgramCacheMs: num(env, 'TOKEN_PROGRAM_CACHE_MS', 5 * 60 * 1000),
  };
}
