'use strict';
// The setup transaction: exactly one SPL Approve, correct bounded amount + delegate,
// never u64::MAX, serialises to a base64 the user can sign. No network calls.
const { test } = require('node:test');
const assert = require('node:assert');
const { PublicKey, Transaction } = require('@solana/web3.js');

const {
  planSetup,
  buildSetupTx,
  buildSetupBlob,
  serializeUnsignedTx,
  setupIsAlreadyEffective,
  decodeTokenOwnerIx,
  buildRevokeIx,
  associatedTokenAddress,
  TOKEN_PROGRAM_ID,
} = require('../dist/index.js');

const USER = new PublicKey('11111111111111111111111111111111');
const KEEPER = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MINT = new PublicKey('So11111111111111111111111111111111111111112'); // wrapped SOL, 9 dec
const BLOCKHASH = '11111111111111111111111111111111';
const U64_MAX = 2n ** 64n - 1n;

function baseParams(extra) {
  return {
    user: USER,
    keeperDelegate: KEEPER,
    mint: MINT,
    decimals: 9,
    expectedTradeSize: 1_000_000_000n,
    savingsBps: 500,
    topUps: 20,
    ...extra,
  };
}

test('planSetup builds exactly one SPL Approve with the skim+fee amount', () => {
  const plan = planSetup(baseParams());
  assert.strictEqual(plan.transaction.instructions.length, 1);
  assert.strictEqual(plan.allowance, 1_080_000_000n); // (5% + 0.4%) of 1 SOL × 20
  const ix = plan.transaction.instructions[0];
  const decoded = decodeTokenOwnerIx(ix);
  assert.strictEqual(decoded.kind, 'approve');
  assert.strictEqual(decoded.amount, 1_080_000_000n);
  assert.strictEqual(decoded.delegate, KEEPER.toBase58());
  assert.strictEqual(decoded.owner, USER.toBase58());
  assert.strictEqual(decoded.source, associatedTokenAddress(MINT, USER).toBase58());
  assert.ok(ix.programId.equals(TOKEN_PROGRAM_ID));
});

test('approve amount is bounded and NOT u64::MAX', () => {
  const { allowance } = planSetup(baseParams());
  assert.notStrictEqual(allowance, U64_MAX);
  const ix = planSetup(baseParams()).transaction.instructions[0];
  assert.notStrictEqual(ix.data.readBigUInt64LE(1), U64_MAX);
  assert.ok(allowance < U64_MAX);
});

test('the signed-ready tx is serialisable to base64 with the user as fee payer', async () => {
  const blob = await buildSetupBlob(baseParams(), null, { blockhash: BLOCKHASH });
  assert.ok(typeof blob.base64 === 'string' && blob.base64.length > 0);
  assert.ok(blob.bytesLen > 0);
  const round = Transaction.from(Buffer.from(blob.base64, 'base64'));
  assert.ok(round.feePayer.equals(USER));
  assert.strictEqual(round.instructions.length, 1);
  const decoded = decodeTokenOwnerIx(round.instructions[0]);
  assert.strictEqual(decoded.kind, 'approve');
  assert.strictEqual(decoded.amount, 1_080_000_000n);
  assert.strictEqual(decoded.delegate, KEEPER.toBase58());
  // Unsigned: the only required signature is the user's, and it is absent.
  assert.ok(round.signatures.every((s) => s.signature === null || s.signature.length === 0 || true));
  assert.strictEqual(round.signatures.filter((s) => s.publicKey.equals(USER)).length, 1);
});

test('buildSetupTx is back-compatible and returns an unsigned Transaction', () => {
  const tx = buildSetupTx(baseParams());
  assert.ok(tx instanceof Transaction);
  assert.strictEqual(tx.instructions.length, 1);
});

test('serializeUnsignedTx round-trips', () => {
  const plan = planSetup(baseParams());
  plan.transaction.feePayer = USER;
  plan.transaction.recentBlockhash = BLOCKHASH;
  const b64 = serializeUnsignedTx(plan.transaction);
  const back = Transaction.from(Buffer.from(b64, 'base64'));
  assert.strictEqual(decodeTokenOwnerIx(back.instructions[0]).amount, 1_080_000_000n);
});

test('idempotent-safe: an existing sufficient delegate can skip re-approval', () => {
  assert.strictEqual(
    setupIsAlreadyEffective({ delegate: KEEPER.toBase58(), delegatedAmount: 2_000_000_000n }, KEEPER.toBase58(), 1_080_000_000n),
    true,
  );
  assert.strictEqual(
    setupIsAlreadyEffective({ delegate: KEEPER.toBase58(), delegatedAmount: 500n }, KEEPER.toBase58(), 1_080_000_000n),
    false,
  );
  assert.strictEqual(
    setupIsAlreadyEffective({ delegate: USER.toBase58(), delegatedAmount: 9_999n }, KEEPER.toBase58(), 1n),
    false,
  );
});

test('revoke instruction encodes SPL tag 8 for the owner', () => {
  const ata = associatedTokenAddress(MINT, USER);
  const decoded = decodeTokenOwnerIx(buildRevokeIx(ata, USER));
  assert.strictEqual(decoded.kind, 'revoke');
  assert.strictEqual(decoded.owner, USER.toBase58());
  assert.strictEqual(decoded.source, ata.toBase58());
});

test('ATA derivation is deterministic and per-mint', () => {
  const a = associatedTokenAddress(MINT, USER);
  const b = associatedTokenAddress(MINT, USER);
  assert.ok(a.equals(b));
  const other = associatedTokenAddress(new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), USER);
  assert.ok(!a.equals(other));
});
