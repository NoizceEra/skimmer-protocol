'use strict';
// Frozen shared store: schema round-trip, atomic write, corrupt recovery, pause.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KEEPER_DELEGATE = process.env.KEEPER_DELEGATE || 'KeepErDeLeGaTe111111111111111111111111111111';

const store = require('../dist/store.js');

const FROZEN_KEYS = [
  'approvedMints',
  'authority',
  'delegate',
  'destination',
  'paused',
  'savingsBps',
  'updatedAt',
];

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-store-'));
  return { dir, file: path.join(dir, 'users.json') };
}

test('round-trips the frozen schema exactly', () => {
  const { file } = tmpFile();
  store.setDataFile(file);
  const s = store.getState(42);
  s.authority = 'So11111111111111111111111111111111111111112';
  s.savingsBps = 500;
  s.destination = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  s.delegate = process.env.KEEPER_DELEGATE;
  s.approvedMints = ['So11111111111111111111111111111111111111112'];
  store.saveState(42);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(raw), ['42']);
  assert.deepStrictEqual(Object.keys(raw['42']).sort(), FROZEN_KEYS);
  assert.strictEqual(raw['42'].authority, s.authority);
  assert.strictEqual(raw['42'].savingsBps, 500);
  assert.strictEqual(raw['42'].destination, s.destination);
  assert.strictEqual(raw['42'].delegate, process.env.KEEPER_DELEGATE);
  assert.strictEqual(raw['42'].paused, false);
  assert.deepStrictEqual(raw['42'].approvedMints, s.approvedMints);
  assert.match(raw['42'].updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  // reload from disk into a fresh instance.
  store.setDataFile(file);
  assert.strictEqual(store.getState(42).savingsBps, 500);
  assert.strictEqual(store.getState(42).authority, s.authority);
});

test('writes atomically (temp file + rename, no leftovers)', () => {
  const { dir, file } = tmpFile();
  store.setDataFile(file);
  store.getState(7).authority = 'So11111111111111111111111111111111111111112';
  store.saveState(7);
  store.saveState(7);
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, []);
  assert.ok(fs.existsSync(file));
});

test('survives and quarantines a corrupt file without crashing', () => {
  const { dir, file } = tmpFile();
  fs.writeFileSync(file, '{ this is definitely not json ', 'utf8');
  store.setDataFile(file);
  assert.doesNotThrow(() => store.getState(1));
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.ok(backups.length >= 1, 'corrupt file should be preserved as .corrupt-*');
  // the bot keeps working and can persist a fresh valid store.
  store.getState(1).authority = 'So11111111111111111111111111111111111111112';
  store.saveState(1);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.strictEqual(store.readStoreFile()['1'].authority, 'So11111111111111111111111111111111111111112');
});

test('incomplete drafts (no authority) are not persisted', () => {
  const { file } = tmpFile();
  store.setDataFile(file);
  const s = store.getState(9);
  s.savingsBps = 500; // no authority yet
  store.saveState(9);
  assert.strictEqual(store.readStoreFile()['9'], undefined);
  if (fs.existsSync(file)) {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  }
});

test('/pause flips paused=true in the store and on disk; /resume flips it back', () => {
  const { file } = tmpFile();
  store.setDataFile(file);
  store.getState(5).authority = 'So11111111111111111111111111111111111111112';
  store.saveState(5);
  assert.strictEqual(store.getState(5).paused, false);

  store.setPaused(5, true);
  assert.strictEqual(store.getState(5).paused, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['5'].paused, true);

  store.setPaused(5, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['5'].paused, false);
});

test('addMint dedupes and persists into approvedMints', () => {
  const { file } = tmpFile();
  store.setDataFile(file);
  store.getState(3).authority = 'So11111111111111111111111111111111111111112';
  store.saveState(3);
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.strictEqual(store.addMint(3, mint), true);
  assert.strictEqual(store.addMint(3, mint), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['3'].approvedMints, [mint]);
});
