'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { formatStatus, verifyDelegations } = require('../dist/status.js');

test('formatStatus shows the real configured state from the store', () => {
  const text = formatStatus({
    authority: 'So11111111111111111111111111111111111111112',
    savingsBps: 500,
    destination: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    delegate: 'KeepErDeLeGaTe111111111111111111111111111111',
    paused: false,
    approvedMints: ['So11111111111111111111111111111111111111112'],
  });
  assert.match(text, /5% \(500 bps\)/);
  assert.match(text, /EPjFWdd5/);
  assert.match(text, /So11111111111111111111111111111111111111112/);
  assert.doesNotMatch(text, /Mints approved|PDA/);
  assert.doesNotMatch(text, /❌ not set/);
});

test('formatStatus reports missing pieces and the onboarding steps', () => {
  const empty = formatStatus({});
  assert.match(empty, /No wallet linked/);
  assert.match(empty, /\/connect/);

  const partial = formatStatus({ authority: 'So11111111111111111111111111111111111111112' });
  assert.match(partial, /❌ not set/);
  assert.match(partial, /\/set_rate/);
  assert.doesNotMatch(partial, /add_mint/);
});

test('formatStatus reflects paused', () => {
  const paused = formatStatus({
    authority: 'So11111111111111111111111111111111111111112',
    savingsBps: 500,
    destination: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    delegate: 'KeepErDeLeGaTe111111111111111111111111111111',
    paused: true,
    approvedMints: [],
  });
  assert.match(paused, /Saving paused/);
  assert.match(paused, /⏸️ yes/);
});

test('verifyDelegations flags approved vs not-delegated mints', async () => {
  const delegate = 'KeepErDeLeGaTe111111111111111111111111111111';
  const mint = 'So11111111111111111111111111111111111111112';
  const fakeConn = {
    getParsedTokenAccountsByOwner: async () => ({
      value: [
        { account: { data: { parsed: { info: { mint, delegate, delegatedAmount: '1080000000' } } } } },
      ],
    }),
  };
  const ok = await verifyDelegations(fakeConn, {
    authority: 'So11111111111111111111111111111111111111112',
    delegate,
    approvedMints: [mint],
  });
  assert.match(ok, /approved, allowance left 1080000000/);

  const bad = await verifyDelegations(fakeConn, {
    authority: 'So11111111111111111111111111111111111111112',
    delegate: 'SomeoneElse1111111111111111111111111111111111',
    approvedMints: [mint],
  });
  assert.match(bad, /not approved yet/);
});

test('verifyDelegations never throws on RPC failure', async () => {
  const broken = {
    getParsedTokenAccountsByOwner: async () => {
      throw new Error('rpc down');
    },
  };
  const out = await verifyDelegations(broken, {
    authority: 'So11111111111111111111111111111111111111112',
    delegate: 'x',
    approvedMints: ['So11111111111111111111111111111111111111112'],
  });
  assert.strictEqual(out, '');
});
