import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createApp, RateLimiter, bearerFrom, safeEqualSecret } from '../src/server';
import type { DrainResult, SkimJob } from '../src/queue';

const USER = '36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV';
const POOL = '5C5ZmJWzc7NZaWjq6VRdaSfF2e1mTN1Gc1ENnD7oYCaS';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SIG1 = 'd814XjoBuviF7Knd8Cjz5sGU3pW4oJNPa5DLwJdaqZMTm5MMnq6MytPwH7yv1U89wXQZUUTHTuRpDvmTYLiY9Cs';

const raw = (tokenAmount: string, decimals: number) => ({ rawTokenAmount: { tokenAmount, decimals } });

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

const transferIn = () => ({
  type: 'TRANSFER',
  signature: SIG1,
  feePayer: USER,
  tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: USER, mint: BONK, ...raw('1', 5) }],
});

function makeQueue() {
  const jobs: SkimJob[] = [];
  return {
    jobs,
    async enqueue(job: SkimJob): Promise<void> {
      jobs.push(job);
    },
    async drain(): Promise<DrainResult> {
      const forwarded = jobs.length;
      return { forwarded, retried: 0, deadLettered: 0, remaining: 0, deferred: 0 };
    },
  };
}

async function start(app: http.RequestListener) {
  const server = http.createServer(app);
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const SECRET = 'test-webhook-secret';
const auth = { authorization: `Bearer ${SECRET}` };

test('GET /health returns the service identity', async () => {
  const queue = makeQueue();
  const app = createApp({ secret: SECRET, queue });
  const srv = await start(app);
  try {
    const res = await fetch(`${srv.base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: 'skim-listener' });
  } finally {
    await srv.close();
  }
});

test('POST /webhook/tx without the bearer secret returns 401', async () => {
  const queue = makeQueue();
  const app = createApp({ secret: SECRET, queue });
  const srv = await start(app);
  try {
    const res = await fetch(`${srv.base}/webhook/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([validSwap()]),
    });
    assert.equal(res.status, 401);
    assert.equal(queue.jobs.length, 0);
  } finally {
    await srv.close();
  }
});

test('POST /webhook/tx with a wrong bearer secret returns 401', async () => {
  const app = createApp({ secret: SECRET, queue: makeQueue() });
  const srv = await start(app);
  try {
    const res = await fetch(`${srv.base}/webhook/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify([validSwap()]),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test('POST /webhook/tx with the bearer secret returns 200 and durably enqueues', async () => {
  const queue = makeQueue();
  const app = createApp({ secret: SECRET, queue });
  const srv = await start(app);
  try {
    const res = await fetch(`${srv.base}/webhook/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify([validSwap()]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.queued, 1);
    assert.equal(body.rejected, 0);

    assert.equal(queue.jobs.length, 1);
    const job = queue.jobs[0];
    assert.equal(job.user, USER);
    assert.equal(job.mint, BONK);
    assert.equal(job.outputAmount, '1234567890000');
    assert.equal(job.decimals, 5);
    assert.equal(job.signature, SIG1);
  } finally {
    await srv.close();
  }
});

test('a non-swap element is rejected without failing the batch', async () => {
  const queue = makeQueue();
  const app = createApp({ secret: SECRET, queue });
  const srv = await start(app);
  try {
    const res = await fetch(`${srv.base}/webhook/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify([transferIn(), null, {}, 42, ['nested'], validSwap()]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.queued, 1);
    assert.equal(body.rejected, 5);
    assert.equal(queue.jobs.length, 1);
  } finally {
    await srv.close();
  }
});

test('a non-array body returns 400', async () => {
  const app = createApp({ secret: SECRET, queue: makeQueue() });
  const srv = await start(app);
  try {
    const res = await fetch(`${srv.base}/webhook/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ not: 'an array' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await srv.close();
  }
});

test('rate limiting returns 429 with Retry-After once the per-IP budget is spent', async () => {
  const queue = makeQueue();
  const limiter = new RateLimiter({ perIp: 2, global: 100, windowMs: 60_000 });
  const app = createApp({ secret: SECRET, queue, rateLimiter: limiter });
  const srv = await start(app);
  try {
    const send = () =>
      fetch(`${srv.base}/webhook/tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify([validSwap()]),
      });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const third = await send();
    assert.equal(third.status, 429);
    const retryAfter = third.headers.get('retry-after');
    assert.ok(retryAfter, 'expected a Retry-After header');
    assert.ok(Number(retryAfter) >= 1);
    assert.equal(queue.jobs.length, 2);
  } finally {
    await srv.close();
  }
});

test('bearer parsing and constant-time secret comparison behave correctly', () => {
  assert.equal(bearerFrom('Bearer abc'), 'abc');
  assert.equal(bearerFrom('bearer   abc '), 'abc');
  assert.equal(bearerFrom('Basic abc'), null);
  assert.equal(bearerFrom(undefined), null);
  assert.equal(safeEqualSecret('same', 'same'), true);
  assert.equal(safeEqualSecret('same', 'different-length'), false);
});
