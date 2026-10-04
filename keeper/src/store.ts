/**
 * Shared user config store (FROZEN INTERFACE CONTRACT v1).
 *
 * Written by the Telegram bot agent, read by the keeper at request time.
 * Path: <repo-root>/data/users.json (overridable via USER_STORE_PATH).
 *
 * The file is untrusted: absent, empty or corrupt MUST NOT crash the keeper.
 */
import * as fs from 'fs';

export interface UserRecord {
  authority: string;
  savingsBps: number;
  destination: string;
  delegate: string;
  paused?: boolean;
  approvedMints?: string[];
  updatedAt?: string;
}

export type UserStore = Record<string, UserRecord>;

export interface ResolvedUser {
  chatId: string;
  authority: string;
  savingsBps: number;
  destination: string;
  delegate: string;
  paused: boolean;
  approvedMints: string[];
  updatedAt?: string;
}

/** Load the store, tolerating absent / empty / corrupt files (returns {}). */
export function loadUserStore(filePath: string): UserStore {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: UserStore = {};
    for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = normalizeRecord(value);
      if (rec) out[chatId] = rec;
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeRecord(value: unknown): UserRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const authority = typeof v.authority === 'string' ? v.authority : '';
  const destination = typeof v.destination === 'string' ? v.destination : '';
  const delegate = typeof v.delegate === 'string' ? v.delegate : '';
  const savingsBps = typeof v.savingsBps === 'number' ? v.savingsBps : Number(v.savingsBps);
  if (authority === '' || destination === '' || delegate === '') return null;
  if (!Number.isFinite(savingsBps)) return null;
  const approvedMints = Array.isArray(v.approvedMints)
    ? v.approvedMints.filter((m): m is string => typeof m === 'string')
    : undefined;
  return {
    authority,
    destination,
    delegate,
    savingsBps: Math.trunc(savingsBps),
    paused: v.paused === true,
    approvedMints,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : undefined,
  };
}

/** Resolve a record by the requested user (authority) pubkey. */
export function findByAuthority(
  store: UserStore,
  authority: string,
): { chatId: string; record: UserRecord } | null {
  for (const [chatId, record] of Object.entries(store)) {
    if (record.authority === authority) return { chatId, record };
  }
  return null;
}

/** Map a stored record to the engine's resolved view. */
export function toResolvedUser(chatId: string, record: UserRecord): ResolvedUser {
  return {
    chatId,
    authority: record.authority,
    savingsBps: record.savingsBps,
    destination: record.destination,
    delegate: record.delegate,
    paused: record.paused === true,
    approvedMints: record.approvedMints ?? [],
    updatedAt: record.updatedAt,
  };
}

/** Resolve directly from the store object, or null when not configured. */
export function resolveFromStore(store: UserStore, authority: string): ResolvedUser | null {
  const hit = findByAuthority(store, authority);
  return hit ? toResolvedUser(hit.chatId, hit.record) : null;
}

/**
 * Build a resolver that RE-READS the on-disk store on every call, so the
 * keeper always honours the latest settings written by the bot. The file is
 * re-read per request (the engine resolves each incoming sweep once).
 */
export function makeUserResolver(filePath: string): (authority: string) => ResolvedUser | null {
  return (authority: string) => resolveFromStore(loadUserStore(filePath), authority);
}
