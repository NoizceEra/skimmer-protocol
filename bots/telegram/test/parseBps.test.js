'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { parseBps, MAX_SAVINGS_BPS, bpsToPct } = require('../dist/store.js');

test("parseBps accepts '5', '5%', '2.5'", () => {
  assert.strictEqual(parseBps('5'), 500);
  assert.strictEqual(parseBps('5%'), 500);
  assert.strictEqual(parseBps('2.5'), 250);
  assert.strictEqual(parseBps(' 10 '), 1000);
  assert.strictEqual(parseBps('0'), 0);
});

test("parseBps rejects '11', 'abc' and ''", () => {
  assert.throws(() => parseBps('11'), /0–10%/);
  assert.throws(() => parseBps('abc'), /number/);
  assert.throws(() => parseBps(''), /required/);
  assert.throws(() => parseBps('5.5.5'), /number/);
  assert.throws(() => parseBps('-1'), /number/);
});

test('bpsToPct and the 10% cap', () => {
  assert.strictEqual(bpsToPct(500), 5);
  assert.strictEqual(MAX_SAVINGS_BPS, 1000);
});
