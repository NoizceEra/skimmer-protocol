import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_SAVINGS_BPS = 1000; // 10% on-chain cap
export const PROTOCOL_FEE_BPS = Number(process.env.PROTOCOL_FEE_BPS ?? 40);

export interface UserState {
  authority?: string;
  savingsBps?: number;
  destination?: string;
  wallet?: string; // smart-wallet PDA
  updatedAt?: string;
}

const DATA_FILE = path.resolve(__dirname, '..', '..', 'data', 'users.json');

const mem = new Map<number, UserState>();
let loaded = false;

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as Record<string, UserState>;
      for (const [k, v] of Object.entries(raw)) mem.set(Number(k), v);
    }
  } catch {
    /* corrupt file -> start fresh, never crash multi-user bot */
  }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const obj: Record<string, UserState> = {};
    for (const [k, v] of mem) obj[String(k)] = v;
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
  } catch {
    /* disk full / readonly -> keep serving from memory */
  }
}

export function getState(chatId: number): UserState {
  loadOnce();
  let s = mem.get(chatId);
  if (!s) {
    s = {};
    mem.set(chatId, s);
  }
  return s;
}

export function saveState(chatId: number): void {
  const s = mem.get(chatId);
  if (s) s.updatedAt = new Date().toISOString();
  persist();
}

export function bpsToPct(bps: number): number {
  return bps / 100;
}

/** Parse "5", "5%", "2.5" -> bps. Enforces 0–1000. */
export function parseBps(input: string): number {
  const cleaned = input.trim().replace(/%$/, '');
  const v = Number(cleaned);
  if (!Number.isFinite(v) || v < 0 || v > 10) throw new Error('Rate must be 0–10% (e.g. 5 for 5%).');
  return Math.round(v * 100);
}
