import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_SAVINGS_BPS = 1000; // 10% on-chain cap
export const PROTOCOL_FEE_BPS = Number(process.env.PROTOCOL_FEE_BPS ?? 40);

/**
 * FROZEN SHARED SCHEMA v1 — the keeper reads this exact on-disk shape.
 * Do not rename/remove fields. One record per Telegram chat id.
 */
export interface UserRecord {
  authority: string; // solana pubkey, base58
  savingsBps: number;
  destination: string; // solana pubkey, base58
  delegate: string; // keeper pubkey, base58
  paused: boolean;
  approvedMints: string[];
  updatedAt: string; // ISO8601
}

/** Loose in-memory draft for a chat that hasn't finished onboarding yet. */
export interface UserState {
  authority?: string;
  savingsBps?: number;
  destination?: string;
  delegate?: string;
  paused?: boolean;
  approvedMints?: string[];
  /** smart-wallet PDA (display only). */
  wallet?: string;
  updatedAt?: string;
}

// ── path resolution ──────────────────────────────────────────────────────────
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'Anchor.toml')) || fs.existsSync(path.join(dir, 'programs'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '..', '..', '..');
}

/** `<repo-root>/data/users.json` unless USER_STORE_PATH overrides it. */
export function defaultDataFile(): string {
  const override = process.env.USER_STORE_PATH;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(findRepoRoot(__dirname), 'data', 'users.json');
}

let DATA_FILE = defaultDataFile();
export function getDataFile(): string {
  return DATA_FILE;
}
/** Testing / embedding hook. */
export function setDataFile(p: string): void {
  DATA_FILE = path.resolve(p);
  mem.clear();
  loaded = false;
}

// ── in-memory cache ──────────────────────────────────────────────────────────
const mem = new Map<string, UserState>();
let loaded = false;

function normalizeRecord(raw: unknown): UserState {
  const r = (raw ?? {}) as Partial<UserRecord>;
  return {
    authority: typeof r.authority === 'string' ? r.authority : undefined,
    savingsBps: typeof r.savingsBps === 'number' ? r.savingsBps : undefined,
    destination: typeof r.destination === 'string' ? r.destination : undefined,
    delegate: typeof r.delegate === 'string' ? r.delegate : undefined,
    paused: typeof r.paused === 'boolean' ? r.paused : undefined,
    approvedMints: Array.isArray(r.approvedMints) ? r.approvedMints.filter((m) => typeof m === 'string') : [],
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : undefined,
  };
}

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(DATA_FILE)) return;
  let raw: string;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch {
    return; // unreadable -> serve from memory, never crash
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        mem.set(k, normalizeRecord(v));
      }
    }
  } catch {
    // Corrupt JSON: preserve the bad file for forensics and start fresh.
    // A multi-user bot must never crash on a bad store.
    try {
      fs.renameSync(DATA_FILE, `${DATA_FILE}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
  }
}

// ── frozen serialisation ─────────────────────────────────────────────────────
function toFrozen(v: UserState): UserRecord {
  return {
    authority: v.authority ?? '',
    savingsBps: typeof v.savingsBps === 'number' ? v.savingsBps : 0,
    destination: v.destination ?? '',
    delegate: v.delegate ?? process.env.KEEPER_DELEGATE ?? '',
    paused: v.paused ?? false,
    approvedMints: Array.isArray(v.approvedMints) ? [...v.approvedMints] : [],
    updatedAt: v.updatedAt ?? new Date().toISOString(),
  };
}

function atomicWrite(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.users.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Only complete records (with an authority) are persisted — never empty drafts. */
function persist(): void {
  const obj: Record<string, UserRecord> = {};
  for (const [k, v] of mem) {
    if (!v.authority) continue;
    obj[k] = toFrozen(v);
  }
  atomicWrite(DATA_FILE, JSON.stringify(obj, null, 2) + '\n');
}

// ── public API ───────────────────────────────────────────────────────────────
export function getState(chatId: number | string): UserState {
  loadOnce();
  const key = String(chatId);
  let s = mem.get(key);
  if (!s) {
    s = {
      delegate: process.env.KEEPER_DELEGATE || undefined,
      approvedMints: [],
      paused: false,
    };
    mem.set(key, s);
  }
  if (!s.approvedMints) s.approvedMints = [];
  return s;
}

export function saveState(chatId: number | string): void {
  const key = String(chatId);
  const s = mem.get(key);
  if (s) s.updatedAt = new Date().toISOString();
  persist();
}

/** The frozen record as it would be written (defaults applied). */
export function getRecord(chatId: number | string): UserRecord {
  return toFrozen(getState(chatId));
}

export function setPaused(chatId: number | string, paused: boolean): UserState {
  const s = getState(chatId);
  s.paused = paused;
  saveState(chatId);
  return s;
}

export function addMint(chatId: number | string, mint: string): boolean {
  const s = getState(chatId);
  if (!s.approvedMints) s.approvedMints = [];
  if (s.approvedMints.includes(mint)) return false;
  s.approvedMints.push(mint);
  saveState(chatId);
  return true;
}

/** Raw parsed on-disk object (for diagnostics/tests). */
export function readStoreFile(): Record<string, UserRecord> {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as Record<string, UserRecord>;
  } catch {
    return {};
  }
}

export function bpsToPct(bps: number): number {
  return bps / 100;
}

/** Parse "5", "5%", "2.5" -> bps. Enforces 0–1000. Rejects "11", "abc", "". */
export function parseBps(input: string): number {
  const cleaned = String(input ?? '')
    .trim()
    .replace(/%$/, '')
    .trim();
  if (cleaned === '') throw new Error('Rate required (0–10%).');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error('Rate must be a number 0–10 (e.g. 5 for 5%).');
  }
  const v = Number(cleaned);
  if (!Number.isFinite(v) || v < 0 || v > 10) {
    throw new Error('Rate must be 0–10% (e.g. 5 for 5%).');
  }
  return Math.round(v * 100);
}
