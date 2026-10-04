/**
 * Tests for Helius watched-address registration and the backfill.
 *
 * NO real network: every test injects a mock fetch. We assert the exact request
 * body the code would PUT (the dangerous failure mode is a naive single-element
 * PUT that unwatches everyone), idempotency, best-effort behaviour, the clean
 * skip when unconfigured, and that the API key never reaches a log line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHeliusRegistrar, type HeliusLogger } from '../src/helius';
import { loadAuthorities, runBackfill } from '../src/scripts/sync-helius-addresses';

const API_KEY = 'helius-test-key-DO-NOT-LEAK';
const WEBHOOK_ID = '11111111-2222-3333-4444-555555555555';
const A = '36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV';
const B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const C = 'So11111111111111111111111111111111111111112';
const D = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

interface CapturedCall {
  url: string;
  method: string;
  body: any;
}
interface MockResult {
  status?: number;
  ok?: boolean;
  json?: unknown;
  throwError?: boolean;
}

function mockFetch(handler: (call: CapturedCall) => MockResult) {
  const calls: CapturedCall[] = [];
  const fn = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const call: CapturedCall = { url, method, body };
    calls.push(call);
    const r = handler(call);
    if (r.throwError) throw new Error('simulated network failure');
    const status = r.status ?? 200;
    const ok = r.ok ?? (status >= 200 && status < 300);
    return {
      ok,
      status,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json ?? ''),
    } as unknown as Response;
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function captureLogger(): { logger: HeliusLogger; lines: Array<Record<string, unknown>>; text: () => string } {
  const lines: Array<Record<string, unknown>> = [];
  const logger: HeliusLogger = {
    info: (message, meta) => lines.push({ level: 'info', message, meta }),
    warn: (message, meta) => lines.push({ level: 'warn', message, meta }),
    error: (message, meta) => lines.push({ level: 'error', message, meta }),
  };
  return { logger, lines, text: () => JSON.stringify(lines) };
}

// ── Registration ──────────────────────────────────────────────────────────────

test('registers a fresh authority and PRESERVES the existing watched addresses', async () => {
  const webhook = {
    webhookID: WEBHOOK_ID,
    webhookURL: 'https://skim.example.com/webhook/tx',
    webhookType: 'enhanced',
    transactionTypes: ['SWAP'],
    authHeader: 'Bearer webhook-secret',
    accountAddresses: [A, B],
  };
  const { fn, calls } = mockFetch((call) =>
    call.method === 'GET'
      ? { status: 200, json: webhook }
      : { status: 200, json: { ...webhook, accountAddresses: call.body.accountAddresses } },
  );
  const registrar = createHeliusRegistrar({ apiKey: API_KEY, webhookId: WEBHOOK_ID, fetchImpl: fn });

  const res = await registrar.registerAddress(C);

  assert.equal(res.status, 'added');
  assert.equal(res.added, 1);
  assert.equal(res.total, 3);

  // Exactly one GET then one PUT.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PUT');
  // Endpoint + shape implemented against: GET/PUT /v0/webhooks/{id}?api-key=<key>.
  assert.ok(
    calls[0].url.endsWith(`/v0/webhooks/${WEBHOOK_ID}?api-key=${encodeURIComponent(API_KEY)}`),
    `unexpected URL: ${calls[0].url.split('?')[0]}`,
  );
  // THE REQUEST BODY: union of existing + new, config preserved.
  assert.deepEqual(calls[1].body.accountAddresses, [A, B, C]);
  assert.equal(calls[1].body.webhookURL, webhook.webhookURL);
  assert.equal(calls[1].body.webhookType, 'enhanced');
  assert.deepEqual(calls[1].body.transactionTypes, ['SWAP']);
  assert.equal(calls[1].body.authHeader, 'Bearer webhook-secret');
});

test('an already-watched authority is a no-op (no PUT issued)', async () => {
  const { fn, calls } = mockFetch(() => ({
    status: 200,
    json: { webhookType: 'enhanced', accountAddresses: [A, B] },
  }));
  const registrar = createHeliusRegistrar({ apiKey: API_KEY, webhookId: WEBHOOK_ID, fetchImpl: fn });

  const res = await registrar.registerAddress(A);

  assert.equal(res.status, 'present');
  assert.equal(res.added, 0);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  assert.equal(calls.length, 1); // just the GET
});

test('adding one address never drops the others (union write-back)', async () => {
  const existing = [A, B, C];
  const { fn, calls } = mockFetch((call) =>
    call.method === 'GET'
      ? { status: 200, json: { webhookType: 'enhanced', accountAddresses: existing } }
      : { status: 200, json: { accountAddresses: call.body.accountAddresses } },
  );
  const registrar = createHeliusRegistrar({ apiKey: API_KEY, webhookId: WEBHOOK_ID, fetchImpl: fn });

  const res = await registrar.registerAddress(D);

  assert.equal(res.status, 'added');
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'a PUT should have been issued');
  assert.deepEqual(put!.body.accountAddresses, [A, B, C, D]);
  for (const addr of existing) {
    assert.ok(put!.body.accountAddresses.includes(addr), `existing ${addr} must survive`);
  }
});

test('registering the same address twice in a row is idempotent', async () => {
  let watched: string[] = [];
  const { fn, calls } = mockFetch((call) => {
    if (call.method === 'GET') return { status: 200, json: { accountAddresses: watched } };
    watched = call.body.accountAddresses;
    return { status: 200, json: { accountAddresses: watched } };
  });
  const registrar = createHeliusRegistrar({ apiKey: API_KEY, webhookId: WEBHOOK_ID, fetchImpl: fn });

  const first = await registrar.registerAddress(A);
  const second = await registrar.registerAddress(A);

  assert.equal(first.status, 'added');
  assert.equal(second.status, 'present');
  assert.deepEqual(watched, [A]);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
});

// ── Best-effort: failures must never throw or leak the key ────────────────────

test('a Helius 500 does not throw and does not block onboarding', async () => {
  const { fn } = mockFetch(() => ({ status: 500, json: { error: 'boom' } }));
  const { logger, lines, text } = captureLogger();
  const registrar = createHeliusRegistrar({ apiKey: API_KEY, webhookId: WEBHOOK_ID, fetchImpl: fn, logger });

  await assert.doesNotReject(() => registrar.registerAddress(A));
  const res = await registrar.registerAddress(A);
  assert.equal(res.status, 'error');
  assert.ok(lines.some((l) => l.level === 'warn'), 'a failure should be logged as a warning');
  assert.ok(!text().includes(API_KEY), 'the api key must never appear in a log line');
});

test('a thrown network error does not escape registerAddress', async () => {
  const { fn } = mockFetch(() => ({ throwError: true }));
  const registrar = createHeliusRegistrar({ apiKey: API_KEY, webhookId: WEBHOOK_ID, fetchImpl: fn });

  await assert.doesNotReject(() => registrar.registerAddress(A));
  const res = await registrar.registerAddress(A);
  assert.equal(res.status, 'error');
});

test('a PUT failure is reported as error, not thrown, and never leaks the key', async () => {
  const { fn } = mockFetch((call) =>
    call.method === 'GET'
      ? { status: 200, json: { accountAddresses: [A] } }
      : { status: 403, json: { error: 'forbidden' } },
  );
  const { logger, text } = captureLogger();
  const registrar = createHeliusRegistrar({ apiKey: API_KEY, webhookId: WEBHOOK_ID, fetchImpl: fn, logger });

  const res = await registrar.registerAddress(B);
  assert.equal(res.status, 'error');
  assert.ok(!text().includes(API_KEY));
});

// ── Clean skip when unconfigured ──────────────────────────────────────────────

test('missing HELIUS_API_KEY skips cleanly and never calls Helius', async () => {
  const { fn, calls } = mockFetch(() => ({ status: 200, json: { accountAddresses: [] } }));
  const { logger, lines } = captureLogger();
  const registrar = createHeliusRegistrar({ webhookId: WEBHOOK_ID, fetchImpl: fn, logger, env: {} });

  assert.equal(registrar.enabled, false);
  const res = await registrar.registerAddress(A);
  assert.equal(res.status, 'skipped');
  assert.equal(calls.length, 0, 'no HTTP request when unconfigured');
  assert.ok(
    lines.some((l) => l.level === 'info' && /skipped/i.test(String(l.message))),
    'a clear skip log line is required',
  );
});

test('missing HELIUS_WEBHOOK_ID skips cleanly', async () => {
  const { fn, calls } = mockFetch(() => ({ status: 200, json: {} }));
  const registrar = createHeliusRegistrar({ apiKey: API_KEY, fetchImpl: fn, env: {} });

  assert.equal(registrar.enabled, false);
  const res = await registrar.registerAddress(A);
  assert.equal(res.status, 'skipped');
  assert.equal(calls.length, 0);
});

test('reads credentials from the env object when options are omitted', () => {
  const registrar = createHeliusRegistrar({
    fetchImpl: mockFetch(() => ({})).fn,
    env: { HELIUS_API_KEY: API_KEY, HELIUS_WEBHOOK_ID: WEBHOOK_ID },
  });
  assert.equal(registrar.enabled, true);
});

// ── Backfill ──────────────────────────────────────────────────────────────────

test('backfill reads every authority (deduped) and registers the union', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-helius-store-'));
  const storePath = path.join(dir, 'users.json');
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      '111': { authority: A, savingsBps: 500, destination: B, delegate: C, paused: false, approvedMints: [] },
      '222': { authority: B, savingsBps: 200, destination: C, delegate: C, paused: false, approvedMints: [] },
      '333': { authority: A }, // duplicate -> deduped
      '444': { savingsBps: 100 }, // no authority -> ignored
    }),
  );

  const loaded = loadAuthorities(storePath);
  assert.equal(loaded.records, 4);
  assert.deepEqual(loaded.authorities, [A, B]);

  const { fn, calls } = mockFetch((call) =>
    call.method === 'GET'
      ? { status: 200, json: { webhookType: 'enhanced', accountAddresses: [C] } }
      : { status: 200, json: { accountAddresses: call.body.accountAddresses } },
  );
  const result = await runBackfill({
    storePath,
    env: { HELIUS_API_KEY: API_KEY, HELIUS_WEBHOOK_ID: WEBHOOK_ID },
    fetchImpl: fn,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.before, 1);
  assert.equal(result.after, 3);
  assert.equal(result.added, 2);
  assert.equal(result.unique, 2);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put);
  assert.deepEqual(put!.body.accountAddresses, [C, A, B]);
});

test('backfill is idempotent — a second run adds nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-helius-store-'));
  const storePath = path.join(dir, 'users.json');
  fs.writeFileSync(storePath, JSON.stringify({ '1': { authority: A }, '2': { authority: B } }));

  let watched: string[] = [A, B];
  const { fn, calls } = mockFetch((call) => {
    if (call.method === 'GET') return { status: 200, json: { accountAddresses: watched } };
    watched = call.body.accountAddresses;
    return { status: 200, json: { accountAddresses: watched } };
  });
  const env = { HELIUS_API_KEY: API_KEY, HELIUS_WEBHOOK_ID: WEBHOOK_ID };

  const result = await runBackfill({ storePath, env, fetchImpl: fn });
  assert.equal(result.added, 0);
  assert.equal(result.before, 2);
  assert.equal(result.after, 2);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('backfill on an empty/missing store is a clean no-op', async () => {
  const { fn, calls } = mockFetch(() => ({ status: 200, json: {} }));
  const result = await runBackfill({
    storePath: path.join(os.tmpdir(), `does-not-exist-${Date.now()}.json`),
    env: { HELIUS_API_KEY: API_KEY, HELIUS_WEBHOOK_ID: WEBHOOK_ID },
    fetchImpl: fn,
  });
  assert.equal(result.unique, 0);
  assert.equal(result.added, 0);
  assert.equal(calls.length, 0);
});
