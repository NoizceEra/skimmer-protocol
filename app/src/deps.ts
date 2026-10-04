/**
 * Sibling-package loader.
 *
 * The three working pieces live in their own npm packages (keeper/, listener/,
 * bots/telegram/) with their own node_modules and compiled dist/. This module is
 * the ONLY place that reaches into them; it requires their built CommonJS output
 * at runtime and casts it to the small interfaces the runner actually uses. That
 * keeps the composition layer thin and avoids recompiling or forking their code.
 *
 * Resolution is by repo-root walk (not a fixed `../../`), so it works identically
 * from app/dist/ and app/dist-test/src/.
 */
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import { findRepoRoot } from './config';

export interface SweepInput {
  authority: string;
  mint: string;
  outputAmount: string;
  decimals: number;
  signature: string;
}

export type SweepResult =
  | { status: 'swept'; signature: string; skim: string; fee: string }
  | { status: 'skipped'; reason: string }
  | { status: 'duplicate' }
  | { status: 'error'; error?: string; attempts?: number };

export interface SweepQueueLike {
  submit(input: SweepInput): Promise<SweepResult>;
  stats(): { pending: number; running: number };
  close(): Promise<void>;
}

export interface DedupeLike {
  claim(signature: string): boolean;
  release(signature: string): void;
  has(signature: string): boolean;
  size(): number;
}

export interface DeadLetterLike {
  add(record: Record<string, unknown>): void;
  list(): Record<string, unknown>[];
}

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

export interface KeeperKeypair {
  publicKey: PublicKey;
  secretKey: Uint8Array;
}

export interface KeeperModules {
  processSkim: (params: Record<string, unknown>) => Promise<SweepResult>;
  makeMintProgramReader: (
    connection: unknown,
    cacheMs: number,
  ) => (mint: unknown) => Promise<string | null>;
  SweepQueue: new (opts: Record<string, unknown>) => SweepQueueLike;
  FileDedupe: new (filePath: string, ttlMs: number) => DedupeLike;
  InMemoryDedupe: new (ttlMs: number) => DedupeLike;
  FileDeadLetter: new (filePath: string) => DeadLetterLike;
  InMemoryDeadLetter: new () => DeadLetterLike;
  makeUserResolver: (filePath: string) => (authority: string) => ResolvedUser | null;
  loadKeypairFromFile: (filePath: string) => KeeperKeypair;
}

export interface ListenerModules {
  createApp: (opts: Record<string, unknown>) => unknown;
  RateLimiter: new (opts: Record<string, unknown>) => unknown;
}

function requireFrom<T>(...segments: string[]): T {
  const target = path.join(findRepoRoot(__dirname), ...segments);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(target) as T;
}

export function loadKeeper(): KeeperModules {
  const engine = requireFrom<Record<string, unknown>>('keeper', 'dist', 'engine.js');
  const queue = requireFrom<Record<string, unknown>>('keeper', 'dist', 'queue.js');
  const dedupe = requireFrom<Record<string, unknown>>('keeper', 'dist', 'dedupe.js');
  const deadletter = requireFrom<Record<string, unknown>>('keeper', 'dist', 'deadletter.js');
  const store = requireFrom<Record<string, unknown>>('keeper', 'dist', 'store.js');
  const config = requireFrom<Record<string, unknown>>('keeper', 'dist', 'config.js');
  return {
    processSkim: engine.processSkim as KeeperModules['processSkim'],
    makeMintProgramReader: engine.makeMintProgramReader as KeeperModules['makeMintProgramReader'],
    SweepQueue: queue.SweepQueue as KeeperModules['SweepQueue'],
    FileDedupe: dedupe.FileDedupe as KeeperModules['FileDedupe'],
    InMemoryDedupe: dedupe.InMemoryDedupe as KeeperModules['InMemoryDedupe'],
    FileDeadLetter: deadletter.FileDeadLetter as KeeperModules['FileDeadLetter'],
    InMemoryDeadLetter: deadletter.InMemoryDeadLetter as KeeperModules['InMemoryDeadLetter'],
    makeUserResolver: store.makeUserResolver as KeeperModules['makeUserResolver'],
    loadKeypairFromFile: config.loadKeypairFromFile as KeeperModules['loadKeypairFromFile'],
  };
}

export function loadListener(): ListenerModules {
  const server = requireFrom<Record<string, unknown>>('listener', 'dist', 'server.js');
  return {
    createApp: server.createApp as ListenerModules['createApp'],
    RateLimiter: server.RateLimiter as ListenerModules['RateLimiter'],
  };
}

/** The grammy Bot instance exported by bots/telegram. REQUIRES a real token env. */
export function loadTelegramBot(): {
  start: (opts?: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
} {
  const mod = requireFrom<Record<string, unknown>>('bots', 'telegram', 'dist', 'bot.js');
  return mod.default as { start: (opts?: Record<string, unknown>) => Promise<void>; stop: () => Promise<void> };
}
