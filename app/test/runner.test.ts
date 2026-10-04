/**
 * Boot smoke tests for the single-process v1 runner.
 *
 * No network, no live Telegram token, no RPC: the bot, the keeper engine and the
 * balance reader are all injected. The REAL listener app and the REAL durable
 * keeper queue are exercised, which is the point — the webhook must flow all the
 * way through to the engine in-process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ConfigError, REQUIRED_VARS, loadConfig } from '../src/config';
import { buildRunner, type RunnerDeps } from '../src/runner';
import { permissiveDedupe } from '../src/queue-bridge';
import type { SweepInput, SweepResult } from '../src/deps';

const USER = '36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV';
const POOL = '5C5ZmJWzc7NZaWjq6VRdaSfF2e1mTN1Gc1ENnD7oYCaS';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SIG1 =
  'd814XjoBuviF7Knd8Cjz5sGU3pW4oJNPa5DLwJdaqZMTm5MMnq6MytPwH7yv1U89wXQZUUTHTuRpDvmTYLiY9Cs';
const TREASURY = 'So11111111111111111111111111111111111111112';
const SECRET = 'test-webhook-secret';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const raw = (tokenAmount: string, decimals: number) => ({
  rawTokenAmount: { tokenAmount, decimals },
});

/** A genuine Helius SWAP event: fee payer sends USDC, receives BONK. */
const validSwap = () => ({
  type: 'SWAP',
  signature: SIG1,
  feePayer: USER,
  transactionError: null,
  tokenTransfers: [
    { fromUserAccount: USER, toUserAccount: POOL, mint: USDC, ...raw('250000000', 6) },
    { fromUserAccount: POOL, toUserAccount: USER, mint: BONK, ...raw('1234567890000', 5) },
  ],
});

function fakeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-v1-test-'));
  const env: NodeJS.ProcessEnv = {
    TELEGRAM_BOT_TOKEN: '123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFa',
    RPC_URL: 'http://127.0.0.1:1',
    TREASURY,
    KEEPER_KEYPAIR: path.join(dir, 'keeper.json'),
    WEBHOOK_SECRET: SECRET,
    USER_STORE_PATH: path.join(dir, 'users.json'),
    KEEPER_STATE_DIR: path.join(dir, 'state'),
    ...overrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

interface FakeDeps {
  deps: RunnerDeps;
  calls: Array<{ input: SweepInput; dedupeHeld: boolean }>;
  botStarted: () => boolean;
}

function makeDeps(): FakeDeps {
  const calls: Array<{ input: SweepInput; dedupeHeld: boolean }> = [];
  const engine = async (input: SweepInput, dedupeHeld: boolean): Promise<SweepResult> => {
    calls.push({ input, dedupeHeld });
    return { status: 'swept', signature: input.signature, skim: '1234', fee: '48' };
  };
  let started = false;
  let stopped = false;
  const deps: RunnerDeps = {
    engine,
    bot: {
      name: 'fake-telegram',
      start: () => {
        started = true;
      },
      stop: () => {
        stopped = true;
      },
      isRunning: () => started && !stopped,
    },
    keeperPubkey: USDC,
    keeperBalance: async () => 1_000_000_000,
    dedupe: permissiveDedupe(),
    deadletter: { add: () => {}, list: () => [] },
  };
  return { deps, calls, botStarted: () => started && !stopped };
}

async function startServer(runner: ReturnType<typeof buildRunner>): Promise<string> {
  const { port } = await runner.listen(0);
  return `http://127.0.0.1:${port}`;
}

test('GET /health reports all three parts without a live token or RPC', async () => {
  const config = loadConfig(fakeEnv());
  const { deps } = makeDeps();
  const runner = buildRunner(config, { deps, logger: silent });
  const base = await startServer(runner);
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.ok, true);
    assert.equal(body.service, 'skim-v1-single-process');
    assert.equal(typeof body.uptimeMs, 'number');
    assert.ok(body.uptimeMs >= 0);

    assert.equal(body.bot.running, false);
    assert.equal(body.bot.name, 'fake-telegram');

    assert.equal(body.listener.queueDepth, 0);
    assert.equal(body.listener.outstanding, 0);
    assert.equal(body.listener.pending, 0);
    assert.equal(body.listener.running, 0);

    assert.equal(body.keeper.pubkey, USDC);
    assert.equal(body.keeper.solLamports, 1_000_000_000);
    assert.equal(body.keeper.lowFunds, false);
    assert.equal(body.keeper.rpc, 'ok');
    assert.equal(body.keeper.envReady, true);
    assert.deepEqual(body.keeper.missingEnv, []);
  } finally {
    await runner.shutdown(2_000);
  }
});

test('an authenticated webhook POST flows through to the keeper engine IN-PROCESS', async () => {
  const config = loadConfig(fakeEnv());
  const { deps, calls } = makeDeps();
  const runner = buildRunner(config, { deps, logger: silent });
  const base = await startServer(runner);
  try {
    const res = await fetch(`${base}/webhook/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify([validSwap()]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.queued, 1);
    assert.equal(body.forwarded, 1);
    assert.equal(body.rejected, 0);

    // Proven in-process: the injected engine saw the parsed swap job, no network.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.authority, USER);
    assert.equal(calls[0].input.mint, BONK);
    assert.equal(calls[0].input.outputAmount, '1234567890000');
    assert.equal(calls[0].input.decimals, 5);
    assert.equal(calls[0].input.signature, SIG1);
    assert.equal(calls[0].dedupeHeld, true);

    // The queue reported the work and is now empty again.
    const stats = runner.queueStats();
    assert.equal(stats.outstanding, 0);
    assert.equal(stats.pending, 0);
    assert.equal(stats.running, 0);
  } finally {
    await runner.shutdown(2_000);
  }
});

test('a webhook POST without the bearer secret is rejected and never reaches the engine', async () => {
  const config = loadConfig(fakeEnv());
  const { deps, calls } = makeDeps();
  const runner = buildRunner(config, { deps, logger: silent });
  const base = await startServer(runner);
  try {
    const res = await fetch(`${base}/webhook/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([validSwap()]),
    });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  } finally {
    await runner.shutdown(2_000);
  }
});

test('bot readiness flips once the bot is started', async () => {
  const config = loadConfig(fakeEnv());
  const { deps, botStarted } = makeDeps();
  const runner = buildRunner(config, { deps, logger: silent });
  try {
    assert.equal((await runner.health()).bot.running, false);
    runner.startBot();
    assert.equal(botStarted(), true);
    assert.equal((await runner.health()).bot.running, true);
  } finally {
    await runner.shutdown(1_000);
  }
});

for (const key of REQUIRED_VARS) {
  test(`a missing ${key} fails fast naming the var`, () => {
    const env = fakeEnv({ [key]: undefined });
    assert.throws(
      () => loadConfig(env),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, 'expected a ConfigError');
        assert.match((err as Error).message, /missing required env var/);
        assert.match((err as Error).message, new RegExp(key));
        return true;
      },
    );
  });
}

test('a bad TREASURY value is rejected with a clear message', () => {
  assert.throws(
    () => loadConfig(fakeEnv({ TREASURY: 'not-a-pubkey' })),
    /TREASURY is not a valid base58 pubkey/,
  );
});
