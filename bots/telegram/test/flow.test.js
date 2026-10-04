'use strict';
// End-to-end conversation harness: drives the REAL bot handlers with fake Telegram
// updates and a mocked transport. Asserts (a) every update gets >=1 reply (nothing is
// silently dropped), (b) every HTML reply would pass Telegram's entity parser, and
// (c) the saved state is what the keeper reads.
process.env.TELEGRAM_BOT_TOKEN = '1:test';
process.env.RPC_URL = 'http://127.0.0.1:1'; // never reaches a network
process.env.KEEPER_DELEGATE = '3r2PfRcxGBbezAWuEAUYHQ2EGfM2RooR6yqYNxtX6n3j';
process.env.PUBLIC_URL = 'https://skim.example';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const store = require('../dist/store');
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skimflow-')), 'users.json');
store.setDataFile(file);
const botMod = require('../dist/bot');
const bot = botMod.default;

const WALLET = 'EzN2REVRGnFog7pi63o5wamzEhQfcibMatxjb7LrZDuK';
const SAVINGS = '85TK12gDB5HEJog6g9Gs7sw9xomrsMfsAy8ZSgGtS3ka';

let calls = [];
bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false };
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  return { ok: true, result: method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: payload.chat_id, type: 'private' } } : true };
});

// Telegram HTML subset validator: allowed tags balanced, no stray < > &.
function assertTelegramHtml(text) {
  const stack = [];
  const allowed = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'a']);
  const re = /<(\/?)([a-z]+)([^>]*)>/gi;
  const stripped = text.replace(re, (m, close, name) => {
    name = name.toLowerCase();
    assert.ok(allowed.has(name), `unsupported tag <${name}> in: ${text}`);
    if (close) assert.strictEqual(stack.pop(), name, `unbalanced </${name}> in: ${text}`);
    else stack.push(name);
    return '';
  });
  assert.strictEqual(stack.length, 0, `unclosed tags ${stack} in: ${text}`);
  assert.ok(!/[<>]/.test(stripped), `raw < or > in: ${text}`);
  assert.ok(!/&(?!(amp|lt|gt|quot);)/.test(stripped), `raw & in: ${text}`);
}

let uid = 1000;
const nextId = () => ++uid;
async function say(chatId, text, type = 'private') {
  calls = [];
  const message = { message_id: nextId(), date: 0, chat: { id: chatId, type }, from: { id: chatId, is_bot: false, first_name: 'T' }, text };
  if (text.startsWith('/')) message.entities = [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }];
  await bot.handleUpdate({ update_id: nextId(), message });
  return checked();
}
async function tap(chatId, data) {
  calls = [];
  await bot.handleUpdate({
    update_id: nextId(),
    callback_query: { id: String(nextId()), chat_instance: 'x', from: { id: chatId, is_bot: false, first_name: 'T' }, data, message: { message_id: 1, date: 0, chat: { id: chatId, type: 'private' }, text: 'x' } },
  });
  return checked();
}
function checked() {
  const sends = calls.filter((c) => c.method === 'sendMessage');
  assert.ok(sends.length >= 1, 'update produced NO reply (silent drop)');
  for (const s of sends) if (s.payload.parse_mode === 'HTML') assertTelegramHtml(s.payload.text);
  return sends.map((s) => s.payload.text).join('\n---\n');
}
const rec = (chatId) => JSON.parse(fs.readFileSync(file, 'utf8'))[String(chatId)];

test('happy path using ONLY plain messages (no commands after /start)', async () => {
  const c = 1;
  const r0 = await say(c, '/start');
  assert.match(r0, /Paste your wallet address/);
  assert.match(await say(c, WALLET), /Wallet connected/);
  assert.strictEqual(rec(c).authority, WALLET);
  assert.match(await say(c, '5'), /Rate set: 5%/);
  assert.strictEqual(rec(c).savingsBps, 500);
  assert.match(await say(c, SAVINGS), /Savings pot set/);
  assert.strictEqual(rec(c).destination, SAVINGS);
  assert.strictEqual(rec(c).delegate, process.env.KEEPER_DELEGATE);
  const sp = await say(c, '/spawn_wallet');
  assert.match(sp, /One tap to finish/);
  const btn = calls.find((x) => x.method === 'sendMessage').payload.reply_markup.inline_keyboard[0][0];
  assert.strictEqual(btn.url, `https://skim.example/sign?a=${WALLET}`);
});

test('bare commands then a separate message (the old silent-drop case)', async () => {
  const c = 2;
  assert.match(await say(c, '/connect'), /Paste your wallet address/);
  assert.match(await say(c, WALLET), /Wallet connected/);
  assert.match(await say(c, '/set_rate'), /What % of each trade/);
  assert.match(await say(c, '7.5%'), /Rate set: 7.5%/);
  assert.match(await say(c, '/set_destination'), /Paste your savings wallet/);
  assert.match(await say(c, `  <${SAVINGS}>  `), /Savings pot set/); // forgiving paste
  assert.strictEqual(rec(c).savingsBps, 750);
});

test('bad input re-prompts and keeps waiting', async () => {
  const c = 3;
  await say(c, '/connect');
  assert.match(await say(c, 'hello there'), /doesn’t look like a Solana address/);
  assert.match(await say(c, WALLET), /Wallet connected/);
  assert.match(await say(c, '/set_rate 99'), /0–10/);
  assert.match(await say(c, 'abc'), /number/);
  assert.match(await say(c, '3'), /Rate set: 3%/);
});

test('bare address / number with nothing armed offers buttons', async () => {
  const c = 4;
  assert.match(await say(c, WALLET), /What is it for/);
  assert.match(await tap(c, `use:c:${WALLET}`), /Wallet connected/);
  await say(c, '/cancel'); // nothing armed now
  assert.match(await say(c, '4'), /Set your savings rate/);
  assert.match(await tap(c, 'use:r:4'), /Rate set: 4%/);
  assert.match(await tap(c, 'dest:same'), /Savings pot set/);
  assert.strictEqual(rec(c).destination, WALLET);
});

test('rate buttons, nav buttons and help/status never go silent', async () => {
  const c = 5;
  await say(c, '/start');
  for (const d of ['nav:connect', 'nav:rate', 'nav:dest', 'nav:wallet', 'nav:status', 'nav:accrued', 'nav:pause', 'nav:help', 'bogus', 'rate:500', 'dest:same']) {
    await tap(c, d);
  }
  for (const m of ['/help', '/status', '/accrued', '/pause', '/resume', '/revoke', '/cancel', '/add_mint', '/add_mint nonsense', '/unknowncmd', '/buy', 'gm', '???']) {
    await say(c, m);
  }
});

test('every command works with a fully-configured user', async () => {
  const c = 6;
  await say(c, '/connect ' + WALLET);
  await say(c, '/set_rate 5');
  await say(c, '/set_destination ' + SAVINGS);
  for (const m of ['/status', '/accrued', '/pause', '/resume', '/spawn_wallet', '/revoke']) await say(c, m);
  const rv = (await say(c, '/revoke'), calls.find((x) => x.method === 'sendMessage').payload.reply_markup.inline_keyboard[0][0].url);
  assert.match(rv, /revoke=1$/);
  assert.strictEqual(rec(c).paused, true);
});

test('non-text messages and group chats get a reply', async () => {
  calls = [];
  await bot.handleUpdate({ update_id: nextId(), message: { message_id: nextId(), date: 0, chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false, first_name: 'T' }, photo: [{ file_id: 'a', file_unique_id: 'b', width: 1, height: 1 }] } });
  assert.ok(calls.some((c) => c.method === 'sendMessage'));
  assert.match(await say(-100, '/connect ' + WALLET, 'group'), /private chat/);
  assert.strictEqual(rec(-100), undefined);
});

test('a handler crash replies instead of going silent', async () => {
  const c = 8;
  const real = store.getState;
  // Force an exception inside a handler by corrupting the persisted file path.
  const prev = fs.writeFileSync;
  fs.writeFileSync = () => { throw new Error('disk full'); };
  try {
    calls = [];
    await bot.handleUpdate({ update_id: nextId(), message: { message_id: nextId(), date: 0, chat: { id: c, type: 'private' }, from: { id: c, is_bot: false, first_name: 'T' }, text: '/connect ' + WALLET, entities: [{ type: 'bot_command', offset: 0, length: 8 }] } });
  } finally {
    fs.writeFileSync = prev;
  }
  assert.ok(calls.some((x) => x.method === 'sendMessage'), 'no reply after handler error');
  void real;
});
