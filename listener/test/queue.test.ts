import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DurableQueue, type QueueLogger, type SkimJob } from '../src/queue';

const silent: QueueLogger = { info: () => {}, warn: () => {} };

const JOB: SkimJob = {
  user: '36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV',
  mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  outputAmount: '1234567890000',
  decimals: 5,
  signature: 'd814XjoBuviF7Knd8Cjz5sGU3pW4oJNPa5DLwJdaqZMTm5MMnq6MytPwH7yv1U89wXQZUUTHTuRpDvmTYLiY9Cs',
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skim-queue-'));
}

type Call = { url: string; init: any };

function capture(response: () => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  const fn = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return response();
  };
  return fn as unknown as typeof fetch;
}

function statusFetch(status: number, calls: Call[] = []): typeof fetch {
  return capture(() => new Response('{}', { status, headers: { 'content-type': 'application/json' } }), calls);
}

test('jobs survive a restart and are forwarded with the exact keeper contract', async () => {
  const dataDir = tmpDir();
  const calls: Call[] = [];
  const fetching = capture(() => new Response('{"status":"swept"}', { status: 200 }), calls);

  const writer = new DurableQueue({
    dataDir,
    keeperUrl: 'http://localhost:5001/',
    keeperSharedSecret: 'sekret',
    retries: 3,
    fetchImpl: fetching,
    logger: silent,
  });
  await writer.enqueue(JOB);
  assert.equal(writer.size(), 1);

  // Simulate a process restart: brand-new instance, same data dir.
  const reader = new DurableQueue({
    dataDir,
    keeperUrl: 'http://localhost:5001',
    keeperSharedSecret: 'sekret',
    retries: 3,
    fetchImpl: fetching,
    logger: silent,
  });
  assert.equal(reader.size(), 1, 'job must persist across instances');

  const result = await reader.drain();
  assert.equal(result.forwarded, 1);
  assert.equal(result.remaining, 0);
  assert.equal(reader.size(), 0, 'queue is drained after a successful forward');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:5001/sweep');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sekret');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    user: JOB.user,
    mint: JOB.mint,
    outputAmount: JOB.outputAmount,
    decimals: JOB.decimals,
    signature: JOB.signature,
  });
});

test('409 duplicate from the keeper is treated as success', async () => {
  const dataDir = tmpDir();
  const q = new DurableQueue({
    dataDir,
    keeperUrl: 'http://k',
    keeperSharedSecret: 's',
    fetchImpl: statusFetch(409),
    logger: silent,
  });
  await q.enqueue(JOB);
  const result = await q.drain();
  assert.equal(result.forwarded, 1);
  assert.equal(result.remaining, 0);
  assert.equal(q.size(), 0);
});

test('5xx is retried with backoff and finally dead-lettered (never lost silently)', async () => {
  const dataDir = tmpDir();
  const calls: Call[] = [];
  const q = new DurableQueue({
    dataDir,
    keeperUrl: 'http://k',
    keeperSharedSecret: 's',
    retries: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: statusFetch(503, calls),
    logger: silent,
  });
  await q.enqueue(JOB);

  const first = await q.drain();
  assert.equal(first.retried, 1);
  assert.equal(first.deadLettered, 0);
  assert.equal(first.remaining, 1);

  const second = await q.drain();
  assert.equal(second.retried, 0);
  assert.equal(second.deadLettered, 1);
  assert.equal(second.remaining, 0);
  assert.equal(calls.length, 2);

  const dead = q.deadLetters();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].job.signature, JOB.signature);
  assert.equal(dead[0].attempts, 2);
});

test('a network error is retryable and succeeds on the next drain', async () => {
  const dataDir = tmpDir();
  let n = 0;
  const flaky = (async () => {
    n += 1;
    if (n === 1) throw new Error('ECONNREFUSED');
    return new Response('{"status":"swept"}', { status: 200 });
  }) as unknown as typeof fetch;

  const q = new DurableQueue({
    dataDir,
    keeperUrl: 'http://k',
    keeperSharedSecret: 's',
    retries: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: flaky,
    logger: silent,
  });
  await q.enqueue(JOB);

  const first = await q.drain();
  assert.equal(first.retried, 1);
  assert.equal(first.remaining, 1);

  const second = await q.drain();
  assert.equal(second.forwarded, 1);
  assert.equal(second.remaining, 0);
});

test('other 4xx is a permanent failure (dead-lettered without retrying)', async () => {
  const dataDir = tmpDir();
  const calls: Call[] = [];
  const q = new DurableQueue({
    dataDir,
    keeperUrl: 'http://k',
    keeperSharedSecret: 's',
    retries: 5,
    fetchImpl: statusFetch(400, calls),
    logger: silent,
  });
  await q.enqueue(JOB);
  const result = await q.drain();
  assert.equal(result.retried, 0);
  assert.equal(result.deadLettered, 1);
  assert.equal(calls.length, 1);
});

test('a torn/corrupt queue line is skipped without losing the valid jobs', async () => {
  const dataDir = tmpDir();
  const calls: Call[] = [];
  const fetching = capture(() => new Response('{}', { status: 200 }), calls);
  fs.mkdirSync(dataDir, { recursive: true });
  const record = { id: 'rec-1', job: JOB, attempts: 0, nextAttemptAt: 0, createdAt: 0 };
  fs.writeFileSync(path.join(dataDir, 'queue.jsonl'), `${JSON.stringify(record)}\n{"garbage": true, \n`);

  const q = new DurableQueue({
    dataDir,
    keeperUrl: 'http://k',
    keeperSharedSecret: 's',
    fetchImpl: fetching,
    logger: silent,
  });
  const result = await q.drain();
  assert.equal(result.forwarded, 1);
  assert.equal(result.remaining, 0);
  assert.equal(calls.length, 1);
});
