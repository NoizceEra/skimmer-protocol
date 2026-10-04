'use strict';
// Allowance math: the approval MUST cover skim + protocol fee, in decimals-aware
// base units, for N top-ups. Run with: node --test test/
const { test } = require('node:test');
const assert = require('node:assert');

const {
  skimFor,
  feeForOutput,
  computeSafeAllowance,
  resolveAllowanceCeiling,
  ceilingFromUsd,
  decimalToBaseUnits,
  DEFAULT_MAX_UI_AMOUNT,
} = require('../dist/index.js');

const ONE_SOL = 1_000_000_000n; // 1 SOL in base units (9 decimals)
const FEE_BPS = 40; // 0.4%

test('skimFor is unchanged (frozen integer-division behaviour)', () => {
  assert.strictEqual(skimFor(1_000_000n, 500), 50_000n);
  assert.strictEqual(skimFor(1_000_000n, FEE_BPS), 4_000n);
  assert.strictEqual(skimFor(0n, 500), 0n);
  assert.strictEqual(skimFor(100n, 1000), 10n);
});

test('feeForOutput is 0.4% of the OUTPUT (not of the skim)', () => {
  assert.strictEqual(feeForOutput(ONE_SOL), 4_000_000n);
  assert.notStrictEqual(feeForOutput(ONE_SOL), skimFor(50_000_000n, FEE_BPS));
});

test('allowance covers skim + fee for N top-ups (500bps, 1 SOL, 20 top-ups)', () => {
  const allowance = computeSafeAllowance({
    expectedTradeSize: ONE_SOL,
    savingsBps: 500,
    topUps: 20,
    decimals: 9,
  });
  const skim = skimFor(ONE_SOL, 500); // 50_000_000
  const fee = skimFor(ONE_SOL, FEE_BPS); // 4_000_000
  assert.strictEqual(skim, 50_000_000n);
  assert.strictEqual(fee, 4_000_000n);
  assert.strictEqual(allowance, (skim + fee) * 20n);
  assert.strictEqual(allowance, 1_080_000_000n); // 1.08 SOL, NOT 1.00 SOL
  // The old (buggy) math used skim only — prove we now include the fee.
  assert.ok(allowance > skim * 20n, 'allowance must exceed skim-only allowance');
});

test('allowance scales linearly with top-ups', () => {
  const one = computeSafeAllowance({
    expectedTradeSize: ONE_SOL,
    savingsBps: 500,
    topUps: 1,
    decimals: 9,
  });
  const five = computeSafeAllowance({
    expectedTradeSize: ONE_SOL,
    savingsBps: 500,
    topUps: 5,
    decimals: 9,
  });
  assert.strictEqual(one, 54_000_000n);
  assert.strictEqual(five, one * 5n);
});

test('decimals-aware: the same UI trade size maps to different base units per mint', () => {
  const sixDec = computeSafeAllowance({
    expectedTradeSize: 1_000_000n, // 1 token @ 6 decimals
    savingsBps: 500,
    topUps: 20,
    decimals: 6,
  });
  const nineDec = computeSafeAllowance({
    expectedTradeSize: 1_000_000_000n, // 1 token @ 9 decimals
    savingsBps: 500,
    topUps: 20,
    decimals: 9,
  });
  assert.strictEqual(sixDec, 1_080_000n);
  assert.strictEqual(nineDec, 1_080_000_000n);
  assert.strictEqual(nineDec, sixDec * 1000n);
});

test('per-mint ceiling is decimals-aware (replaces the old flat 10^10 cap)', () => {
  assert.strictEqual(resolveAllowanceCeiling({ decimals: 9 }), 100n * 10n ** 9n); // 1e11
  assert.strictEqual(resolveAllowanceCeiling({ decimals: 6 }), 100n * 10n ** 6n); // 1e8
  assert.strictEqual(
    resolveAllowanceCeiling({ decimals: 15 }),
    100n * 10n ** 15n, // 1e17 — the old 1e10 cap would have been ~0.00001 tokens
  );
  assert.strictEqual(
    resolveAllowanceCeiling({ decimals: 4, maxUiAmount: '50' }),
    50n * 10n ** 4n,
  );
});

test('USD ceiling is decimals-aware and integer-only', () => {
  // $100 of a $2 token = 50 tokens.
  assert.strictEqual(ceilingFromUsd('100', '2', 9), 50n * 10n ** 9n);
  assert.strictEqual(ceilingFromUsd('100', '2', 6), 50n * 10n ** 6n);
  assert.strictEqual(ceilingFromUsd('10', '0.5', 6), 20n * 10n ** 6n);
  assert.strictEqual(resolveAllowanceCeiling({ decimals: 6, usdCeiling: '10', priceUsdPerToken: '0.5' }), 20n * 10n ** 6n);
});

test('decimalToBaseUnits converts human decimals exactly', () => {
  assert.strictEqual(decimalToBaseUnits('1', 9), 1_000_000_000n);
  assert.strictEqual(decimalToBaseUnits('2.5', 6), 2_500_000n);
  assert.strictEqual(decimalToBaseUnits(DEFAULT_MAX_UI_AMOUNT, 9), 100_000_000_000n);
});

test('rejects an absurd/overflowing request that exceeds the per-mint ceiling', () => {
  assert.throws(
    () =>
      computeSafeAllowance({
        expectedTradeSize: 1_000_000_000_000_000_000_000n, // 1e21 base units
        savingsBps: 500,
        topUps: 20,
        decimals: 9,
      }),
    /exceeds the per-mint ceiling/,
  );
  assert.throws(
    () =>
      computeSafeAllowance({
        expectedTradeSize: ONE_SOL,
        savingsBps: 500,
        topUps: 10 ** 9, // 1e9 top-ups -> overflow-sized total
        decimals: 9,
      }),
    /exceeds the per-mint ceiling/,
  );
});

test('rejects bad inputs instead of silently approving', () => {
  assert.throws(() => computeSafeAllowance({ expectedTradeSize: 0n, savingsBps: 500, decimals: 9 }));
  assert.throws(() =>
    computeSafeAllowance({ expectedTradeSize: ONE_SOL, savingsBps: 11000, decimals: 9 }),
  );
  // decimals is required for a decimals-aware ceiling...
  assert.throws(() => computeSafeAllowance({ expectedTradeSize: ONE_SOL, savingsBps: 500 }), /decimals is required/);
  // ...unless an explicit base-unit ceiling is supplied.
  assert.strictEqual(
    computeSafeAllowance({
      expectedTradeSize: ONE_SOL,
      savingsBps: 500,
      topUps: 2,
      maxAllowanceBaseUnits: 200_000_000n,
    }),
    108_000_000n,
  );
});

test('ceiling must be at least the requested allowance', () => {
  assert.throws(
    () =>
      computeSafeAllowance({
        expectedTradeSize: ONE_SOL,
        savingsBps: 500,
        topUps: 20,
        maxAllowanceBaseUnits: 1_000_000n, // 0.001 SOL, way under
      }),
    /exceeds the per-mint ceiling/,
  );
});
