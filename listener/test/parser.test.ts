import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSwapEvent,
  isBase58Pubkey,
  isBase58Signature,
  base58Decode,
} from '../src/parser';

// --- fixtures ------------------------------------------------------------------
// All pubkeys below are valid base58 encodings of exactly 32 bytes; signatures are
// valid base58 of exactly 64 bytes (generated from fixed byte patterns).
const USER = '36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV';
const POOL = '5C5ZmJWzc7NZaWjq6VRdaSfF2e1mTN1Gc1ENnD7oYCaS';
const POOL2 = '9P3tdyPdGbncE8FJ91ebciWYAUgqeCuoekKNvjXxa6Uk';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = '7HZjCdxJwMaauKVZckY7baatbZY1LLHguuuTWSJH2r8u';
const TOK_SMALL = 'BUY45JpwbqzdYw12fGm5bSMnVjowaMCG9MGMpEevZkUT';
const TOK_BIG = 'Da2DWeGFw6CesiZ1U7Ed2YVuGbxyZRktdzKLy6T6L8Se';

const SIG1 = 'd814XjoBuviF7Knd8Cjz5sGU3pW4oJNPa5DLwJdaqZMTm5MMnq6MytPwH7yv1U89wXQZUUTHTuRpDvmTYLiY9Cs';
const SIG2 = '2FD9cqYHAsFiVe1Y91Rj58T47Ba16gS74BYtTqSMBf3Nc9hnfmSaNiAnB6wpqofyd6jcckwGjeQTjYZzADzEFfVg';
const SIG3 = '2sJJB9Lm9paikAhHeteiAB2qkKKW8ZZqiaFuiKPpw8mqgp6uT8xG3yAQC4KiCDQAv5c8aNJp76qM5nhQEAY4edz5';
const SIG4 = '3VPSjT9F8muizhP3AmshFDcdPSxeLgNee3Fg33o9FqQb5KALd66BSsE6gPrkjkYavR7uHM5Jq3NvPrZGjSAgYVr4';
const SIG5 = '47UbHkwj7jEjFE4ngf6gKYaxs64V4i9w4vhiPG77WTxZHjos3ZzdFdWw4zuVPWisUmUo6qgHBVqbY5HwpYFiP31D';
const SIG6 = '4jZjr4kD6gZjVkPpNWQ1MeR1sdqtDUBMQRS1Hqhks29bzrEWK5u4aK2yA5av5Qq2ib99azYvco28u2CsELiMhk9x';
const SIG7 = '9CZR5qYBog3zwykcGMkvFL6PUQrucks4rhQi266eAX4iefXiXaPr6B2yNg4L8ZhitWQiGwUs7KfVhFCZQTzErdR';
const SIG8 = '9D68aPdPWR7RgjUe3nG2q8ELbHhC2od97juZMpf7tUiPHuEt4iT2AWJ8GHvrv8u1BXuDG649xyReDykgk2rZF6q';
const SIG9 = '9E9ZZVonuuEHAEvhcdGFH745LHQwvwBpP1xreBtFb8Gyma5jgYVsSYAbjDGu2xzzCdU5R4hTZobMD45VPWQs2rR';
const SIG10 = '9EgH43tzceHhtzejQ3iCv3AH1dJC3RRjayZ635XApXnkfS5FPk1DPXgBndLpWjJY149JoXDjz6msc6eAe67p2JX';
const SIG11 = '9Fji3A5Q28QZNW26g7vjtLRjAJ6CygYqjw2VwYCQHfc6mvrWfaDs1cHm51VJKA7Npdc4wWvbG7GJA5gMLfe2jpj';

/** Wrapped SOL (native mint) and two traffic-mint tokens for SOL-in fixtures. */
const WSOL = 'So11111111111111111111111111111111111111112';
const MEME = 'DEX5zFVEMZPjEkUGSpJ6woAbGqnGnC8LoTtks7A6TEK';
const MEME2 = 'DKsH6oWcHTHEZcSrEWkF5TipBEjjav8wb5UrzKUQwCZ';

const raw = (tokenAmount: string, decimals: number) => ({ rawTokenAmount: { tokenAmount, decimals } });

/** Classic Jupiter TOKEN -> TOKEN swap: user pays USDC, receives BONK. */
const jupiterSwap = () => ({
  type: 'SWAP',
  signature: SIG1,
  feePayer: USER,
  transactionError: null,
  tokenTransfers: [
    { fromUserAccount: USER, toUserAccount: POOL, mint: USDC, ...raw('250000000', 6) },
    { fromUserAccount: POOL, toUserAccount: USER, mint: BONK, ...raw('1234567890000', 5) },
  ],
});

/**
 * Jupiter-style SOL -> token buy: the fee payer spends NATIVE SOL (a system
 * transfer, NOT an SPL transfer) and receives an SPL token. `nativeTransfers`
 * carries the SOL leg; `tokenTransfers` carries only the received token.
 */
const jupiterSolBuy = () => ({
  description: 'User swapped 1 SOL for MEME',
  type: 'SWAP',
  source: 'JUPITER',
  fee: 5000,
  feePayer: USER,
  signature: SIG7,
  transactionError: null,
  nativeTransfers: [{ fromUserAccount: USER, toUserAccount: POOL, amount: 1000000000 }],
  tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: USER, mint: MEME, ...raw('42000000000', 6) }],
  accountData: [
    { account: USER, nativeBalanceChange: -1000005000, tokenBalanceChanges: [] },
    { account: POOL, nativeBalanceChange: 1000000000, tokenBalanceChanges: [] },
  ],
});

/** Token -> SOL sell: the fee payer GIVES UP an SPL token and RECEIVES native SOL. */
const tokenSellForSol = () => ({
  description: 'User swapped MEME for SOL',
  type: 'SWAP',
  source: 'JUPITER',
  fee: 5000,
  feePayer: USER,
  signature: SIG8,
  transactionError: null,
  nativeTransfers: [{ fromUserAccount: POOL, toUserAccount: USER, amount: 995000000 }],
  tokenTransfers: [{ fromUserAccount: USER, toUserAccount: POOL, mint: MEME, ...raw('42000000000', 6) }],
  // net native change is POSITIVE (received SOL minus fee) -> not a native spend.
  accountData: [{ account: USER, nativeBalanceChange: 994995000, tokenBalanceChanges: [] }],
});

/** Pure wrap: the payer's SOL moves into their own WSOL balance. Not a trade. */
const pureWrap = () => ({
  type: 'WRAP',
  fee: 5000,
  feePayer: USER,
  signature: SIG9,
  transactionError: null,
  nativeTransfers: [{ fromUserAccount: USER, toUserAccount: WSOL, amount: 1000000000 }],
  tokenTransfers: [{ fromUserAccount: WSOL, toUserAccount: USER, mint: WSOL, ...raw('1000000000', 9) }],
  accountData: [{ account: USER, nativeBalanceChange: -1000005000, tokenBalanceChanges: [] }],
});

/** Pure unwrap: the payer burns their WSOL and receives native SOL. Not a trade. */
const pureUnwrap = () => ({
  type: 'UNWRAP',
  fee: 5000,
  feePayer: USER,
  signature: SIG10,
  transactionError: null,
  nativeTransfers: [{ fromUserAccount: WSOL, toUserAccount: USER, amount: 1000000000 }],
  tokenTransfers: [{ fromUserAccount: USER, toUserAccount: WSOL, mint: WSOL, ...raw('1000000000', 9) }],
});

// --- tests ---------------------------------------------------------------------

test('genuine Jupiter-style swap yields exactly one job with correct mint/amount/decimals', () => {
  const job = parseSwapEvent(jupiterSwap());
  assert.ok(job, 'expected a job');
  assert.equal(job!.user, USER);
  assert.equal(job!.mint, BONK);
  assert.equal(job!.outputAmount, '1234567890000');
  assert.equal(job!.decimals, 5);
  assert.equal(job!.signature, SIG1);
  assert.equal(job!.confidence, 'high');
});

test('plain token transfer-in produces NULL (no outgoing leg)', () => {
  const event = {
    type: 'TRANSFER',
    signature: SIG2,
    feePayer: USER,
    tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: USER, mint: BONK, ...raw('1000', 5) }],
  };
  assert.equal(parseSwapEvent(event), null);
});

test('airdrop / claim (inbound only, even when typed SWAP) produces NULL', () => {
  const airdrop = {
    type: 'AIRDROP',
    signature: SIG2,
    feePayer: USER,
    tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: USER, mint: BONK, ...raw('999999', 5) }],
  };
  assert.equal(parseSwapEvent(airdrop), null);

  // A malicious/incorrect type:'SWAP' with no outgoing leg must still be rejected.
  const spoofed = { ...airdrop, type: 'SWAP' };
  assert.equal(parseSwapEvent(spoofed), null);
});

test('multi-hop swap selects the true output mint, not the intermediate', () => {
  const event = {
    type: 'SWAP',
    signature: SIG3,
    feePayer: USER,
    tokenTransfers: [
      { fromUserAccount: USER, toUserAccount: POOL, mint: USDC, ...raw('100000000', 6) }, // pay
      { fromUserAccount: POOL, toUserAccount: USER, mint: BONK, ...raw('5000000000', 5) }, // intermediate in
      { fromUserAccount: USER, toUserAccount: POOL2, mint: BONK, ...raw('5000000000', 5) }, // intermediate out
      { fromUserAccount: POOL2, toUserAccount: USER, mint: WIF, ...raw('777000000', 6) }, // final out
    ],
  };
  const job = parseSwapEvent(event);
  assert.ok(job);
  // BONK is larger in raw units but it was also sent out -> intermediate, rejected.
  assert.equal(job!.mint, WIF);
  assert.equal(job!.outputAmount, '777000000');
  assert.equal(job!.decimals, 6);
});

test('prefers the largest incoming leg when several are not sent out', () => {
  const event = {
    type: 'SWAP',
    signature: SIG4,
    feePayer: USER,
    tokenTransfers: [
      { fromUserAccount: USER, toUserAccount: POOL, mint: USDC, ...raw('100', 6) },
      { fromUserAccount: POOL, toUserAccount: USER, mint: TOK_SMALL, ...raw('5', 9) },
      { fromUserAccount: POOL, toUserAccount: USER, mint: TOK_BIG, ...raw('9000000', 9) },
    ],
  };
  const job = parseSwapEvent(event);
  assert.ok(job);
  assert.equal(job!.mint, TOK_BIG);
  assert.equal(job!.outputAmount, '9000000');
});

test('failed transaction (transactionError) produces NULL', () => {
  const event = { ...jupiterSwap(), transactionError: { InstructionError: [0, 'Custom'] } };
  assert.equal(parseSwapEvent(event), null);
});

test('missing decimals produces NULL and is logged (job dropped, never guessed)', () => {
  const messages: string[] = [];
  const event = {
    type: 'SWAP',
    signature: SIG5,
    feePayer: USER,
    tokenTransfers: [
      { fromUserAccount: USER, toUserAccount: POOL, mint: USDC, ...raw('1', 6) },
      { fromUserAccount: POOL, toUserAccount: USER, mint: BONK, rawTokenAmount: { tokenAmount: '123' } },
    ],
  };
  const job = parseSwapEvent(event, { log: (m) => messages.push(m) });
  assert.equal(job, null);
  assert.ok(messages.some((m) => m.includes('decimals unavailable')));
});

test('decimals can come from event token metadata (lower confidence, derived amount)', () => {
  const event = {
    type: 'SWAP',
    signature: SIG6,
    feePayer: USER,
    tokenMetadata: { [BONK]: { decimals: 5 } },
    tokenTransfers: [
      { fromUserAccount: USER, toUserAccount: POOL, mint: USDC, ...raw('1', 6) },
      { fromUserAccount: POOL, toUserAccount: USER, mint: BONK, tokenAmount: 1.5 },
    ],
  };
  const job = parseSwapEvent(event);
  assert.ok(job);
  assert.equal(job!.decimals, 5);
  assert.equal(job!.outputAmount, '150000');
  assert.equal(job!.confidence, 'low');
});

test('malformed fee payer / signature / mint are rejected', () => {
  assert.equal(parseSwapEvent({ ...jupiterSwap(), feePayer: 'not-a-real-key!!' }), null);
  assert.equal(parseSwapEvent({ ...jupiterSwap(), signature: 'too-short' }), null);
  assert.equal(parseSwapEvent(null), null);
  assert.equal(parseSwapEvent([]), null);
  assert.equal(parseSwapEvent({ type: 'SWAP' }), null);
});

test('base58 helpers accept only correctly-sized keys', () => {
  assert.equal(isBase58Pubkey(USER), true);
  assert.equal(isBase58Pubkey(USDC), true);
  assert.equal(isBase58Pubkey('0OIl'), false); // excluded base58 chars
  assert.equal(isBase58Pubkey(SIG1), false); // 64 bytes, not a pubkey
  assert.equal(isBase58Signature(SIG1), true);
  assert.equal(isBase58Signature(USER), false); // 32 bytes, not a signature
  assert.equal(base58Decode('0OIl'), null);
  assert.equal(base58Decode(USER)!.length, 32);
  assert.equal(base58Decode(SIG1)!.length, 64);
});

// --- native-SOL-in swap coverage -------------------------------------------------

test('SOL -> token buy produces exactly one job for the RECEIVED token (native SOL outgoing leg)', () => {
  const job = parseSwapEvent(jupiterSolBuy());
  assert.ok(job, 'expected a SOL-in buy to yield a job');
  assert.equal(job!.user, USER);
  assert.equal(job!.mint, MEME);
  assert.equal(job!.outputAmount, '42000000000');
  assert.equal(job!.decimals, 6);
  assert.equal(job!.signature, SIG7);
  assert.equal(job!.confidence, 'high');
});

test('SOL -> token buy still drops the job when decimals are unavailable (never guessed)', () => {
  const messages: string[] = [];
  const event = jupiterSolBuy();
  // Received token carries a raw amount but NO decimals anywhere -> must be dropped.
  (event as any).tokenTransfers = [
    { fromUserAccount: POOL, toUserAccount: USER, mint: MEME, rawTokenAmount: { tokenAmount: '42000000000' } },
  ];
  const job = parseSwapEvent(event, { log: (m) => messages.push(m) });
  assert.equal(job, null);
  assert.ok(messages.some((m) => m.includes('decimals unavailable')));
});

test('token -> SOL sell produces NULL (v1 does not skim native SOL out)', () => {
  // Documented decision: native SOL is not an SPL balance, so there is no truthful
  // mint to charge in base units. Reporting WSOL would target an account the payer
  // does not hold. Therefore a SOL-out sell is NOT a job.
  const job = parseSwapEvent(tokenSellForSol());
  assert.equal(job, null);
});

test('native SOL leg can be inferred from accountData when nativeTransfers is absent', () => {
  const event = {
    type: 'SWAP',
    fee: 5000,
    feePayer: USER,
    signature: SIG7,
    transactionError: null,
    tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: USER, mint: MEME, ...raw('123', 6) }],
    // No nativeTransfers entry, but the payer spent far more than the fee in SOL.
    accountData: [{ account: USER, nativeBalanceChange: -2500005000, tokenBalanceChanges: [] }],
  };
  const job = parseSwapEvent(event);
  assert.ok(job, 'accountData fallback should still recognise the SOL leg');
  assert.equal(job!.mint, MEME);
  assert.equal(job!.outputAmount, '123');
});

test('a fee-only native delta does NOT count as a SOL leg (airdrop recipient still rejected)', () => {
  // Regression guard for the security fix: the recipient paid ONLY the network fee,
  // so nativeBalanceChange == -fee. That must NOT be mistaken for spending SOL.
  const airdrop = {
    type: 'AIRDROP',
    fee: 5000,
    feePayer: USER,
    signature: SIG11,
    transactionError: null,
    tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: USER, mint: BONK, ...raw('999999', 5) }],
    accountData: [{ account: USER, nativeBalanceChange: -5000, tokenBalanceChanges: [] }],
  };
  assert.equal(parseSwapEvent(airdrop), null);
});

test('plain outgoing send (no incoming token) produces NULL even with a native leg', () => {
  const event = {
    type: 'TRANSFER',
    fee: 5000,
    feePayer: USER,
    signature: SIG8,
    transactionError: null,
    nativeTransfers: [{ fromUserAccount: USER, toUserAccount: POOL, amount: 12345 }],
    tokenTransfers: [{ fromUserAccount: USER, toUserAccount: POOL, mint: BONK, ...raw('1000', 5) }],
  };
  assert.equal(parseSwapEvent(event), null);
});

test('pure wrap (payer receives only their own WSOL) produces NULL', () => {
  assert.equal(parseSwapEvent(pureWrap()), null);
});

test('pure unwrap (payer receives only native SOL) produces NULL', () => {
  assert.equal(parseSwapEvent(pureUnwrap()), null);
});

test('SOL-in buy routing through an intermediate WSOL still selects the real token', () => {
  const event = {
    type: 'SWAP',
    fee: 5000,
    feePayer: USER,
    signature: SIG9,
    transactionError: null,
    nativeTransfers: [{ fromUserAccount: USER, toUserAccount: POOL, amount: 500000000 }],
    tokenTransfers: [
      { fromUserAccount: POOL, toUserAccount: USER, mint: WSOL, ...raw('500000000', 9) }, // wrapped intermediate in
      { fromUserAccount: USER, toUserAccount: POOL2, mint: WSOL, ...raw('500000000', 9) }, // wrapped intermediate out
      { fromUserAccount: POOL2, toUserAccount: USER, mint: MEME2, ...raw('777000', 6) }, // final output
    ],
  };
  const job = parseSwapEvent(event);
  assert.ok(job);
  assert.equal(job!.mint, MEME2);
  assert.equal(job!.outputAmount, '777000');
  assert.equal(job!.decimals, 6);
});

test('reverted SOL-in buy produces NULL', () => {
  const event = { ...jupiterSolBuy(), transactionError: { InstructionError: [0, 'Custom'] } };
  assert.equal(parseSwapEvent(event), null);
});

test('malformed-length mint on the received leg of a SOL-in buy is rejected', () => {
  const event = jupiterSolBuy();
  event.tokenTransfers = [{ fromUserAccount: POOL, toUserAccount: USER, mint: 'abc', ...raw('1', 6) }];
  assert.equal(parseSwapEvent(event), null);
});
