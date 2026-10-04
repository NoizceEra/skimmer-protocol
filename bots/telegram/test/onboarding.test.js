'use strict';
// The setup delivery: base64 blob + honest, bounded, revocable explanation.
const { test } = require('node:test');
const assert = require('node:assert');

const { baseUnitsToUi, formatSetupMessage, sdkAvailable } = require('../dist/onboarding.js');

test('baseUnitsToUi renders human amounts per mint decimals', () => {
  assert.strictEqual(baseUnitsToUi('1080000000', 9), '1.08');
  assert.strictEqual(baseUnitsToUi('1080000', 6), '1.08');
  assert.strictEqual(baseUnitsToUi('1000000000', 9), '1');
  assert.strictEqual(baseUnitsToUi('0', 9), '0');
});

test('formatSetupMessage hands the user a bounded, revocable, unsigned tx', () => {
  const plan = {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    base64: 'AQIDBAU=',
    bytesLen: 5,
    allowanceBaseUnits: '1080000000',
    expectedTradeSize: '1000000000',
    topUps: 20,
  };
  const msg = formatSetupMessage(plan, {
    user: 'So11111111111111111111111111111111111111112',
    savingsBps: 500,
    delegate: 'KeepErDeLeGaTe111111111111111111111111111111',
  });
  assert.match(msg, /ONE-TIME APPROVAL/);
  assert.match(msg, /NOT unlimited/);
  assert.match(msg, /REVOCABLE/);
  assert.match(msg, /unsigned/);
  assert.match(msg, /1080000000 base units \(~1\.08 tokens\)/);
  assert.match(msg, /Covers ~20 trades/);
  assert.match(msg, /KeepErDeLeGaTe/);
  assert.ok(msg.includes('AQIDBAU='), 'must include the base64 blob');
});

test('sdkAvailable reflects whether the SDK dist is built (never throws)', () => {
  assert.strictEqual(typeof sdkAvailable(), 'boolean');
});
