/**
 * Backfill — register EVERY onboarded user's authority with the Helius webhook.
 *
 * The single-process runner already adds a wallet to the webhook's watched list
 * when the user connects (/connect). This script covers everyone who onboarded
 * BEFORE that existed: it reads the shared user store (data/users.json — records
 * keyed by chat id, each with an `authority` field), collects the unique
 * authorities, and adds them all to the Helius webhook's `accountAddresses` in a
 * single read-merge-write. It is idempotent (already-watched addresses are left
 * untouched) and prints clear before/after counts.
 *
 * Usage:
 *   npm --prefix app run build
 *   npm --prefix app run sync:helius          # uses app/.env + <repo>/data/users.json
 *   USER_STORE_PATH=/path/to/users.json npm --prefix app run sync:helius
 *
 * Env: HELIUS_API_KEY, HELIUS_WEBHOOK_ID (see app/.env.example). If either is
 * unset the script reports SKIPPED and exits 0 — nothing to do, nothing broken.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findRepoRoot } from '../config';
import { createHeliusRegistrar, type HeliusLogger, type SyncResult } from '../helius';

export interface BackfillResult extends SyncResult {
  storePath: string;
  /** Number of records in the store. */
  records: number;
  /** Distinct, non-empty authorities. */
  unique: number;
}

/** Read every `authority` from the shared store. Tolerant of a missing/corrupt file. */
export function loadAuthorities(storePath: string): { records: number; authorities: string[] } {
  if (!fs.existsSync(storePath)) return { records: 0, authorities: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return { records: 0, authorities: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { records: 0, authorities: [] };
  }
  const authorities: string[] = [];
  const seen = new Set<string>();
  let records = 0;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    records += 1;
    const authority =
      value && typeof value === 'object' ? (value as Record<string, unknown>).authority : undefined;
    if (typeof authority === 'string' && authority.trim() && !seen.has(authority.trim())) {
      seen.add(authority.trim());
      authorities.push(authority.trim());
    }
  }
  return { records, authorities };
}

export function defaultStorePath(): string {
  return path.join(findRepoRoot(__dirname), 'data', 'users.json');
}

export async function runBackfill(opts: {
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: HeliusLogger;
} = {}): Promise<BackfillResult> {
  const env = opts.env ?? process.env;
  const requestedStore = opts.storePath ?? env.USER_STORE_PATH;
  const storePath = requestedStore && requestedStore.trim() ? path.resolve(requestedStore.trim()) : defaultStorePath();

  const { records, authorities } = loadAuthorities(storePath);
  if (authorities.length === 0) {
    return { storePath, records, unique: 0, status: 'ok', before: 0, after: 0, added: 0, requested: 0 };
  }

  const registrar = createHeliusRegistrar({ env, fetchImpl: opts.fetchImpl, logger: opts.logger });
  const result = await registrar.registerAddresses(authorities);
  return { storePath, records, unique: authorities.length, ...result };
}

function format(result: BackfillResult): string {
  const head = `helius sync: store=${result.storePath} records=${result.records} unique=${result.unique}`;
  if (result.status === 'skipped') {
    return `${head} status=SKIPPED — set HELIUS_API_KEY and HELIUS_WEBHOOK_ID (app/.env.example) to register.`;
  }
  if (result.status === 'error') {
    return `${head} status=ERROR — Helius request failed; watched addresses unchanged. See the log line above.`;
  }
  return `${head} status=ok watched: before=${result.before} after=${result.after} added=${result.added}`;
}

async function main(): Promise<void> {
  const result = await runBackfill({ logger: console });
  console.log(format(result));
  process.exitCode = result.status === 'error' ? 1 : 0;
}

if (require.main === module) {
  void main();
}
