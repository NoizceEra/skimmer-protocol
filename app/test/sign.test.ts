/**
 * Tests for the web signing flow routes.
 *
 * No live RPC, no real wallet, no real user store.
 * All I/O is injected via SignRouteDeps.
 *
 * UNVERIFIED (requires a real browser + wallet extension):
 *   - wallet popup appearance / behaviour
 *   - actual on-chain tx submission
 *   - wallet pubkey mismatch UI flow
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import express from 'express';
import { Connection } from '@solana/web3.js';

import { loadConfig } from '../src/config';
import {
  mountSignRoutes,
  RateLimiter,
  buildSignHtml,
  type SignRouteDeps,
  type ResolveUserFn,
  type BuildApprovalsFn,
} from '../src/sign';
import type { ResolvedUser, WalletApprovalTx } from '../src/deps';

// ── Constants ─────────────────────────────────────────────────────────────────

const AUTHORITY = '36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV';
const DELEGATE  = 'So11111111111111111111111111111111111111112';
const MINT      = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ATA       = '5C5ZmJWzc7NZaWjq6VRdaSfF2e1mTN1Gc1ENnD7oYCaS';
const TREASURY  = 'So11111111111111111111111111111111111111112';
const SECRET    = 'test-secret';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-sign-test-'));
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

const fakeUser = (): ResolvedUser => ({
  chatId: '99999',
  authority: AUTHORITY,
  savingsBps: 500,
  destination: TREASURY,
  delegate: DELEGATE,
  paused: false,
  approvedMints: [],
});

const fakeTx = (): WalletApprovalTx => ({
  base64: Buffer.from('fake-tx').toString('base64'),
  items: [{ mint: MINT, tokenAccount: ATA, decimals: 6, allowanceBaseUnits: '1000000' }],
});

interface Fixture {
  base: string;
  close: () => Promise<void>;
}

async function startFixture(
  config: ReturnType<typeof loadConfig>,
  partialDeps: Partial<SignRouteDeps> = {},
): Promise<Fixture> {
  const app = express();
  const connection = new Connection('http://127.0.0.1:1', 'confirmed');

  const defaults: SignRouteDeps = {
    resolveUser: () => null,
    buildApprovals: async () => [],
    rpcForward: async () => ({ jsonrpc: '2.0', id: 1, result: 'ok' }),
    cluster: 'devnet',
    rateLimiter: new RateLimiter(30, 60_000),
  };

  mountSignRoutes(app, config, connection, DELEGATE, { ...defaults, ...partialDeps });

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => { server.off('error', reject); resolve(); });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Tests: GET /api/approvals ─────────────────────────────────────────────────

test('GET /api/approvals — missing authority → 400', async () => {
  const cfg = loadConfig(fakeEnv());
  const fx = await startFixture(cfg);
  try {
    const res = await fetch(`${fx.base}/api/approvals`);
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(typeof body.error === 'string');
  } finally { await fx.close(); }
});

test('GET /api/approvals — invalid pubkey → 400', async () => {
  const cfg = loadConfig(fakeEnv());
  const fx = await startFixture(cfg);
  try {
    const res = await fetch(`${fx.base}/api/approvals?authority=not-a-pubkey`);
    assert.equal(res.status, 400);
  } finally { await fx.close(); }
});

test('GET /api/approvals — unknown authority → 404', async () => {
  const cfg = loadConfig(fakeEnv());
  const fx = await startFixture(cfg, { resolveUser: () => null });
  try {
    const res = await fetch(`${fx.base}/api/approvals?authority=${AUTHORITY}`);
    assert.equal(res.status, 404);
  } finally { await fx.close(); }
});

test('GET /api/approvals — savingsBps=0 → 404', async () => {
  const cfg = loadConfig(fakeEnv());
  const user: ResolvedUser = { ...fakeUser(), savingsBps: 0 };
  const fx = await startFixture(cfg, { resolveUser: () => user });
  try {
    const res = await fetch(`${fx.base}/api/approvals?authority=${AUTHORITY}`);
    assert.equal(res.status, 404);
  } finally { await fx.close(); }
});

test('GET /api/approvals — valid user with txs → 200, no RPC URL in body', async () => {
  const cfg = loadConfig(fakeEnv({ RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=SECRET123' }));
  const tx = fakeTx();
  const fx = await startFixture(cfg, {
    resolveUser: () => fakeUser(),
    buildApprovals: async () => [tx],
    cluster: 'mainnet-beta',
  });
  try {
    const res = await fetch(`${fx.base}/api/approvals?authority=${AUTHORITY}`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.delegate, DELEGATE);
    assert.equal(body.cluster, 'mainnet-beta');
    assert.ok(Array.isArray(body.txs));
    assert.equal((body.txs as unknown[]).length, 1);

    // Must never expose RPC URL or API key
    const bodyStr = JSON.stringify(body);
    assert.ok(!bodyStr.includes('SECRET123'), 'RPC API key must not appear in response');
    assert.ok(!bodyStr.includes('helius-rpc'), 'RPC host must not appear in response');
  } finally { await fx.close(); }
});

test('GET /api/approvals — mints param filters to onlyMints', async () => {
  const cfg = loadConfig(fakeEnv());
  let capturedOnlyMints: string[] | undefined;
  const buildApprovals: BuildApprovalsFn = async (_conn, p) => {
    capturedOnlyMints = p.onlyMints;
    return [fakeTx()];
  };
  const fx = await startFixture(cfg, { resolveUser: () => fakeUser(), buildApprovals });
  try {
    await fetch(`${fx.base}/api/approvals?authority=${AUTHORITY}&mints=${MINT},abc`);
    assert.deepEqual(capturedOnlyMints, [MINT, 'abc']);
  } finally { await fx.close(); }
});

test('GET /api/approvals — rate limit fires after 30 requests', async () => {
  const cfg = loadConfig(fakeEnv());
  const rateLimiter = new RateLimiter(3, 60_000); // 3/min for test speed
  const fx = await startFixture(cfg, { resolveUser: () => null, rateLimiter });
  try {
    // 3 requests are fine (all 404 because resolveUser=null, but not 429)
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${fx.base}/api/approvals?authority=${AUTHORITY}`);
      assert.notEqual(r.status, 429, `request ${i + 1} should not be rate-limited`);
    }
    // 4th should be rate-limited
    const r4 = await fetch(`${fx.base}/api/approvals?authority=${AUTHORITY}`);
    assert.equal(r4.status, 429);
  } finally { await fx.close(); }
});

// ── Tests: POST /api/rpc ──────────────────────────────────────────────────────

test('POST /api/rpc — allowed method forwarded', async () => {
  const cfg = loadConfig(fakeEnv());
  const rpcForward = async (body: unknown) => ({ jsonrpc: '2.0', id: 1, result: 'blockhash-abc' });
  const fx = await startFixture(cfg, { rpcForward });
  try {
    const res = await fetch(`${fx.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.result, 'blockhash-abc');
  } finally { await fx.close(); }
});

test('POST /api/rpc — disallowed method → 403', async () => {
  const cfg = loadConfig(fakeEnv());
  const fx = await startFixture(cfg);
  try {
    const res = await fetch(`${fx.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [] }),
    });
    assert.equal(res.status, 403);
    const body = await res.json() as Record<string, unknown>;
    assert.ok((body.error as string).includes('getAccountInfo'));
  } finally { await fx.close(); }
});

test('POST /api/rpc — disallowed method getBalance → 403', async () => {
  const cfg = loadConfig(fakeEnv());
  const fx = await startFixture(cfg);
  try {
    const res = await fetch(`${fx.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] }),
    });
    assert.equal(res.status, 403);
  } finally { await fx.close(); }
});

test('POST /api/rpc — sendTransaction allowed', async () => {
  const cfg = loadConfig(fakeEnv());
  const fx = await startFixture(cfg, {
    rpcForward: async () => ({ jsonrpc: '2.0', id: 1, result: 'sig123' }),
  });
  try {
    const res = await fetch(`${fx.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['base64data'] }),
    });
    assert.equal(res.status, 200);
  } finally { await fx.close(); }
});

test('POST /api/rpc — RPC URL never appears in 403 error body', async () => {
  const cfg = loadConfig(fakeEnv({ RPC_URL: 'https://my-rpc.com/?api-key=TOPSECRET' }));
  const fx = await startFixture(cfg);
  try {
    const res = await fetch(`${fx.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'badMethod', params: [] }),
    });
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.ok(!text.includes('TOPSECRET'), 'API key must not appear in error response');
    assert.ok(!text.includes('my-rpc.com'), 'RPC host must not appear in error response');
  } finally { await fx.close(); }
});

// ── Tests: GET /sign ──────────────────────────────────────────────────────────

test('GET /sign — returns 200 HTML with security headers', async () => {
  const cfg = loadConfig(fakeEnv());
  const fx = await startFixture(cfg);
  try {
    const res = await fetch(`${fx.base}/sign?a=${AUTHORITY}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/html'));
    assert.ok(res.headers.get('x-frame-options') === 'DENY');
    assert.ok(res.headers.get('referrer-policy') === 'no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes('cdn.jsdelivr.net'), 'CSP must allow CDN');
    assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP must deny framing');
    assert.ok(csp.includes("connect-src 'self'"), 'CSP must only allow same-origin XHR');
  } finally { await fx.close(); }
});

test('GET /sign — HTML contains no unescaped XSS injection from authority param', async () => {
  const cfg = loadConfig(fakeEnv());
  const fx = await startFixture(cfg);
  // Malicious authority: attempts to inject a script tag
  const evil = '</script><script>alert(1)</script>';
  try {
    const res = await fetch(`${fx.base}/sign?a=${encodeURIComponent(evil)}`);
    const html = await res.text();
    // The evil string must not appear literally in HTML
    assert.ok(!html.includes('</script><script>alert(1)'), 'raw script injection must not appear');
    // But the page should still render (200)
    assert.equal(res.status, 200);
  } finally { await fx.close(); }
});

test('GET /sign — embedded JS parses (node --check)', async () => {
  // Build the HTML page and extract the inline script (last <script> block)
  const html = buildSignHtml(AUTHORITY, '', false);

  // Extract inline script (everything after the CDN <script> src line)
  const cdnMarker = '</script>\n<script>\n';
  const endMarker = '\n</script>\n</body>';
  const start = html.indexOf(cdnMarker);
  assert.ok(start !== -1, 'CDN marker not found in HTML');
  const scriptStart = start + cdnMarker.length;
  const scriptEnd = html.indexOf(endMarker, scriptStart);
  assert.ok(scriptEnd !== -1, 'End script marker not found in HTML');
  const script = html.slice(scriptStart, scriptEnd);

  const tmpFile = path.join(os.tmpdir(), `skim-sign-script-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, script, 'utf8');
  try {
    const result = cp.spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8' });
    assert.equal(result.status, 0,
      `node --check failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
});

test('GET /sign — revoke mode sets IS_REVOKE=true in page JS', async () => {
  const cfg = loadConfig(fakeEnv());
  const fx = await startFixture(cfg);
  try {
    const res = await fetch(`${fx.base}/sign?a=${AUTHORITY}&revoke=1`);
    const html = await res.text();
    assert.ok(html.includes('IS_REVOKE = true'), 'IS_REVOKE should be true in revoke mode');
  } finally { await fx.close(); }
});

// ── Tests: new-token prompt throttle ─────────────────────────────────────────

import { buildRunner, type RunnerDeps } from '../src/runner';
import { permissiveDedupe } from '../src/queue-bridge';
import type { SweepInput, SweepResult } from '../src/deps';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USER  = '36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function makeSkipDeps(reason: string): { deps: RunnerDeps; messages: string[] } {
  const messages: string[] = [];
  const engine = async (_input: SweepInput, _dedupeHeld: boolean): Promise<SweepResult> =>
    ({ status: 'skipped', reason });
  const deps: RunnerDeps = {
    engine,
    bot: {
      name: 'fake',
      start: () => {},
      stop: async () => {},
      isRunning: () => false,
      sendMessage: async (_chatId: string, text: string) => { messages.push(text); },
    },
    keeperPubkey: TREASURY,
    keeperBalance: async () => 1_000_000_000,
    dedupe: permissiveDedupe(),
    deadletter: { add: () => {}, list: () => [] },
  };
  return { deps, messages };
}

/** Encode a Buffer as bitcoin-alphabet base58. */
const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buf: Buffer): string {
  const digits: number[] = [];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let leading = 0;
  for (const b of buf) { if (b !== 0) break; leading++; }
  return '1'.repeat(leading) + digits.reverse().map(d => B58_ALPHA[d]).join('');
}
/** Random valid 64-byte base58 Solana-signature-shaped string. */
function makeFakeSig(): string { return base58Encode(crypto.randomBytes(64)); }

async function fireWebhook(base: string, secret: string, user: string, mint: string): Promise<void> {
  const POOL = '5C5ZmJWzc7NZaWjq6VRdaSfF2e1mTN1Gc1ENnD7oYCaS';
  const body = [{
    type: 'SWAP',
    signature: makeFakeSig(),
    feePayer: user,
    transactionError: null,
    tokenTransfers: [
      { fromUserAccount: user, toUserAccount: POOL, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', rawTokenAmount: { tokenAmount: '100', decimals: 6 } },
      { fromUserAccount: POOL, toUserAccount: user, mint, rawTokenAmount: { tokenAmount: '200', decimals: 5 } },
    ],
  }];
  await fetch(`${base}/webhook/tx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  // Allow queue to drain
  await new Promise((r) => setTimeout(r, 200));
}

test('new-token prompt: no-delegate result sends one message when PUBLIC_URL set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-prompt-test-'));
  const storePath = path.join(dir, 'users.json');
  const store = {
    '12345': {
      authority: USER,
      savingsBps: 500,
      destination: TREASURY,
      delegate: TREASURY,
      paused: false,
      approvedMints: [],
    },
  };
  fs.writeFileSync(storePath, JSON.stringify(store));

  const env = fakeEnv({ USER_STORE_PATH: storePath, PUBLIC_URL: 'https://example.com' });
  const config = loadConfig(env);
  const { deps, messages } = makeSkipDeps('no-delegate');
  const runner = buildRunner(config, { deps, logger: silent });
  const { port } = await runner.listen(0);
  try {
    await fireWebhook(`http://127.0.0.1:${port}`, SECRET, USER, BONK);
    assert.equal(messages.length, 1, 'should send exactly one message');
    assert.ok(messages[0].includes('https://example.com/sign?a='), 'message should contain sign link');
    assert.ok(messages[0].includes(encodeURIComponent(USER)), 'link should contain authority');
    assert.ok(messages[0].includes(encodeURIComponent(BONK)), 'link should contain mint');
    assert.ok(messages[0].includes('future trades'), 'message should mention future trades');
  } finally {
    await runner.shutdown(1_000);
  }
});

test('new-token prompt: throttled — second fire within 24h sends no additional message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-prompt-throttle-'));
  const storePath = path.join(dir, 'users.json');
  const store = {
    '12345': {
      authority: USER,
      savingsBps: 500,
      destination: TREASURY,
      delegate: TREASURY,
      paused: false,
      approvedMints: [],
    },
  };
  fs.writeFileSync(storePath, JSON.stringify(store));

  const env = fakeEnv({ USER_STORE_PATH: storePath, PUBLIC_URL: 'https://example.com' });
  const config = loadConfig(env);
  const { deps, messages } = makeSkipDeps('no-delegate');
  const runner = buildRunner(config, { deps, logger: silent });
  const { port } = await runner.listen(0);
  try {
    await fireWebhook(`http://127.0.0.1:${port}`, SECRET, USER, BONK);
    await fireWebhook(`http://127.0.0.1:${port}`, SECRET, USER, BONK);
    assert.equal(messages.length, 1, 'throttle should prevent second message within 24h');
  } finally {
    await runner.shutdown(1_000);
  }
});

test('new-token prompt: skipped when PUBLIC_URL not set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-prompt-nourl-'));
  const storePath = path.join(dir, 'users.json');
  const store = {
    '12345': { authority: USER, savingsBps: 500, destination: TREASURY, delegate: TREASURY, paused: false, approvedMints: [] },
  };
  fs.writeFileSync(storePath, JSON.stringify(store));

  // No PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN
  const env = fakeEnv({ USER_STORE_PATH: storePath });
  delete env['PUBLIC_URL'];
  delete env['RAILWAY_PUBLIC_DOMAIN'];
  const config = loadConfig(env);
  const { deps, messages } = makeSkipDeps('no-delegate');
  const runner = buildRunner(config, { deps, logger: silent });
  const { port } = await runner.listen(0);
  try {
    await fireWebhook(`http://127.0.0.1:${port}`, SECRET, USER, BONK);
    assert.equal(messages.length, 0, 'no message when PUBLIC_URL not set');
  } finally {
    await runner.shutdown(1_000);
  }
});

test('new-token prompt: non-no-delegate skips do NOT send a message', async () => {
  const env = fakeEnv({ PUBLIC_URL: 'https://example.com' });
  const config = loadConfig(env);
  const { deps, messages } = makeSkipDeps('not-configured');
  const runner = buildRunner(config, { deps, logger: silent });
  const { port } = await runner.listen(0);
  try {
    await fireWebhook(`http://127.0.0.1:${port}`, SECRET, USER, BONK);
    assert.equal(messages.length, 0, 'non-no-delegate skips must not send a message');
  } finally {
    await runner.shutdown(1_000);
  }
});
