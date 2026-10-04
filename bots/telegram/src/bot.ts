'use strict';
/**
 * 🛰️ Skimmer Telegram bot — onboarding + status ONLY.
 * No swaps. No buy/sell. Trading happens on other apps.
 * The bot never holds keys and never signs for the user.
 *
 * Fool-proof input model:
 *  - every step arms the NEXT step, so the user can just paste the value (an
 *    address or a number) as a plain message — no command needed;
 *  - a bare pasted address / number with nothing armed offers one-tap buttons;
 *  - replies are HTML and fall back to plain text if Telegram rejects entities,
 *    so a formatting error can never swallow a reply;
 *  - any handler error replies to the user instead of failing silently.
 */
import { Bot, InlineKeyboard, Context } from 'grammy';
import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
dotenv.config();

import { getState, saveState, parseBps, bpsToPct, addMint, setPaused } from './store';
import type { UserState } from './store';
import { formatStatus, verifyDelegations, walletPda } from './status';

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in bots/telegram/.env');
  process.exit(1);
}
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const KEEPER_DELEGATE = process.env.KEEPER_DELEGATE ?? '';
const connection = new Connection(RPC, 'confirmed');
const bot = new Bot(token);

// ── helpers ──────────────────────────────────────────────────────────────────
export const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Convert the legacy-Markdown subset used by status.ts (*bold*, `code`) to safe HTML. */
export function mdToHtml(text: string): string {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const code = (s: string) => `<code>${esc(s)}</code>`;

// ── Helius watched-address registration (injected by the host process) ───────
/**
 * The single-process runner (app/src/runner.ts) injects a registrar here so that
 * every wallet completing /connect is added to the Helius webhook's watched
 * address list — otherwise Helius, whose transaction webhooks are ADDRESS-SCOPED,
 * never fires POST /webhook/tx for that user's trades. When the bot runs
 * standalone (or under test) no registrar is injected and this is a no-op.
 * Best-effort by contract: it never throws and never blocks the reply.
 */
export type HeliusRegisterFn = (authority: string) => Promise<unknown>;
let heliusRegister: HeliusRegisterFn | null = null;
export function setHeliusRegistrar(fn: HeliusRegisterFn | null): void {
  heliusRegister = fn;
}
function registerWithHelius(authority: string): void {
  if (!heliusRegister) return;
  const reg = heliusRegister;
  Promise.resolve()
    .then(() => reg(authority))
    .catch((err) => console.error('helius register failed', (err as Error)?.message ?? err));
}

/** Extract the first token of free text and validate it as a Solana address. */
export function parseAddr(raw: string): string {
  const tok = String(raw ?? '')
    .replace(/[`<>"'“”‘’(),]/g, ' ')
    .trim()
    .split(/\s+/)[0];
  if (!tok) throw new Error('empty');
  const pk = new PublicKey(tok);
  if (pk.equals(PublicKey.default)) throw new Error('zero address');
  return pk.toBase58();
}

export function looksLikeAddr(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return false;
  try {
    parseAddr(t);
    return true;
  } catch {
    return false;
  }
}

function publicBase(): string {
  const p = process.env.PUBLIC_URL?.trim();
  if (p) return p.replace(/\/+$/, '');
  const d = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return d ? `https://${d}` : '';
}
export const signUrl = (authority: string, extra = ''): string =>
  `${publicBase()}/sign?a=${encodeURIComponent(authority)}${extra}`;

// ── Telegram API transformer: never lose a reply to a formatting error ───────
bot.api.config.use(async (prev, method, payload, signal) => {
  let res = await prev(method, payload, signal);
  const p: any = payload;
  if (!res.ok && res.error_code === 429) {
    const wait = Math.min(Number((res as any).parameters?.retry_after ?? 1), 5);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await prev(method, payload, signal);
  }
  if (!res.ok && /can't parse entities/i.test(res.description ?? '') && p?.parse_mode) {
    const { parse_mode: _drop, ...rest } = p;
    for (const k of ['text', 'caption']) {
      if (typeof rest[k] === 'string') rest[k] = rest[k].replace(/<[^>]+>/g, '');
    }
    return prev(method, rest, signal);
  }
  return res;
});

installGuard(bot); // must be registered before any handler

// ── conversation state: what are we waiting for from this chat? ──────────────
type Awaiting = 'connect' | 'rate' | 'dest';
const AWAIT_TTL_MS = 15 * 60 * 1000;
const awaiting = new Map<number, { kind: Awaiting; at: number }>();
const arm = (chatId: number, kind: Awaiting) => awaiting.set(chatId, { kind, at: Date.now() });
const disarm = (chatId: number) => awaiting.delete(chatId);
function currentAwait(chatId: number): Awaiting | null {
  const a = awaiting.get(chatId);
  if (!a) return null;
  if (Date.now() - a.at > AWAIT_TTL_MS) {
    awaiting.delete(chatId);
    return null;
  }
  return a.kind;
}

// ── keyboards ────────────────────────────────────────────────────────────────
const mainKb = () =>
  new InlineKeyboard()
    .text('🔗 Wallet', 'nav:connect')
    .text('💰 Rate', 'nav:rate')
    .row()
    .text('🏦 Savings', 'nav:dest')
    .text('🚀 Approve', 'nav:wallet')
    .row()
    .text('📊 Status', 'nav:status')
    .text('💎 Accrued', 'nav:accrued')
    .row()
    .text('⏸️ Pause', 'nav:pause')
    .text('❓ Help', 'nav:help');

const rateKb = () =>
  new InlineKeyboard()
    .text('2%', 'rate:200')
    .text('5%', 'rate:500')
    .text('10%', 'rate:1000');

const WELCOME = [
  '✂️ <b>Skimmer Protocol</b> — pay yourself first! 💸',
  '',
  '🤖 I auto-save a cut of every trade you make — on any app, any token. You keep trading, I keep skimming. 🏖️',
  '',
  '👣 <b>3 quick steps:</b>',
  '1️⃣ 🔗 your wallet address',
  '2️⃣ 💰 your savings % (e.g. 5)',
  '3️⃣ 🏦 where savings land',
  '',
  'Then one tap to approve in your wallet ✅ — that’s it.',
  '🔑 I never hold your keys. I never trade. I just save. 🛡️',
].join('\n');

const HELP = [
  '❓ <b>What I understand:</b>',
  '',
  '🔗 /connect — your trading wallet',
  '💰 /set_rate — your savings cut (0–10%)',
  '🏦 /set_destination — your savings wallet',
  '🚀 /spawn_wallet — approve in your wallet (one tap)',
  '📊 /status — your setup + on-chain check',
  '💎 /accrued — savings balance',
  '⏸️ /pause · ▶️ /resume — stop / restart saving',
  '🛑 /revoke — remove my permission completely',
  '↩️ /cancel — forget what I was waiting for',
  '',
  '💡 You can also just <b>paste</b> a wallet address or a % and I will ask what it is for.',
  '🚫 No buying or selling here — trade on any app, saving is automatic! ✨',
].join('\n');

// ── the guided "what's next?" engine ─────────────────────────────────────────
type Reply = { text: string; kb?: InlineKeyboard };

function nextStep(chatId: number, prefix = ''): Reply {
  const s = getState(chatId);
  const pre = prefix ? `${prefix}\n\n` : '';
  if (!s.authority) {
    arm(chatId, 'connect');
    return { text: `${pre}1️⃣ 🔗 <b>Paste your wallet address</b> (Phantom, Solflare…) — just send it as a message. 👇` };
  }
  if (s.savingsBps == null) {
    arm(chatId, 'rate');
    return { text: `${pre}2️⃣ 💰 <b>What % of each trade should I save?</b>\nTap one or type a number (0–10). 👇`, kb: rateKb() };
  }
  if (!s.destination) {
    arm(chatId, 'dest');
    return {
      text: `${pre}3️⃣ 🏦 <b>Where should savings land?</b>\nPaste a savings wallet address (tip: a separate wallet keeps it untouched 🐷), or tap below to use your own wallet.`,
      kb: new InlineKeyboard().text('Use my own wallet', 'dest:same'),
    };
  }
  disarm(chatId);
  const link = publicBase() ? signUrl(s.authority) : '';
  return {
    text: `${pre}✅ <b>Setup saved.</b> One last step: approve me in your wallet (a bounded, revocable permission — never unlimited).\n\n👉 /spawn_wallet`,
    kb: link ? new InlineKeyboard().url('✍️ Approve in my wallet', link) : mainKb(),
  };
}

async function send(ctx: Context, r: Reply) {
  await ctx.reply(r.text, { ...HTML, ...(r.kb ? { reply_markup: r.kb } : {}) });
}

// ── actions (shared by commands, plain-text replies, and buttons) ────────────
async function doConnect(ctx: Context, raw: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  let addr: string;
  try {
    addr = parseAddr(raw);
  } catch {
    arm(chatId, 'connect');
    await ctx.reply('🤔 That doesn’t look like a Solana address. Paste it again (32–44 letters/numbers, e.g. from Phantom → Copy address). 👇', HTML);
    return false;
  }
  const s = getState(chatId);
  const changed = s.authority && s.authority !== addr;
  s.authority = addr;
  if (!s.delegate && KEEPER_DELEGATE) s.delegate = KEEPER_DELEGATE;
  saveState(chatId);
  // Ensure Helius watches this wallet so its trades reach the listener/keeper.
  // Fire-and-forget: the registrar handles its own errors and never blocks.
  registerWithHelius(addr);
  await send(ctx, nextStep(chatId, `🔗 <b>Wallet connected!</b> ✅\n${code(addr)}${changed ? '\n(replaced your previous wallet — re-approve with /spawn_wallet)' : ''}`));
  return true;
}

async function doRate(ctx: Context, raw: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  let bps: number;
  try {
    bps = parseBps(raw);
  } catch (e: any) {
    arm(chatId, 'rate');
    await ctx.reply(`💰 ${esc(e.message)}\nTry 2, 5 or 10 — or tap a button. 👇`, { ...HTML, reply_markup: rateKb() });
    return false;
  }
  const s = getState(chatId);
  s.savingsBps = bps;
  saveState(chatId);
  await send(ctx, nextStep(chatId, `💰 <b>Rate set: ${bpsToPct(bps)}%!</b> 🎯 Every trade saves ${bpsToPct(bps)}%.`));
  return true;
}

async function doDest(ctx: Context, raw: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  let addr: string;
  try {
    addr = parseAddr(raw);
  } catch {
    arm(chatId, 'dest');
    await ctx.reply('🤔 That doesn’t look like a Solana address. Paste your savings wallet address again. 👇', HTML);
    return false;
  }
  const s = getState(chatId);
  s.destination = addr;
  saveState(chatId);
  await send(ctx, nextStep(chatId, `🏦 <b>Savings pot set!</b> ✅\n${code(addr)}`));
  return true;
}

async function doSpawn(ctx: Context) {
  const chatId = ctx.chat!.id;
  const s = getState(chatId);
  if (!s.authority || s.savingsBps == null || !s.destination) {
    await send(ctx, nextStep(chatId, '👣 Let’s finish setup first.'));
    return;
  }
  const delegate = s.delegate || KEEPER_DELEGATE;
  if (!delegate) {
    await ctx.reply('⚙️ Protocol not configured — the operator must set KEEPER_DELEGATE. Nothing to sign yet.');
    return;
  }
  s.delegate = delegate;
  s.wallet = walletPda(new PublicKey(s.authority))[0].toBase58();
  saveState(chatId);
  if (!publicBase()) {
    await ctx.reply('⚙️ The signing page is not configured — the operator must set PUBLIC_URL. Nothing to sign yet.');
    return;
  }
  const link = signUrl(s.authority);
  await ctx.reply(
    [
      '🚀 <b>One tap to finish.</b>',
      '',
      `Open the link with the wallet you connected (${code(s.authority.slice(0, 4) + '…' + s.authority.slice(-4))}) and approve.`,
      `It grants my keeper a <b>bounded, revocable</b> permission on the tokens you hold — never unlimited, and I never see your keys.`,
      '',
      `💰 Saving ${bpsToPct(s.savingsBps)}% → ${code(s.destination.slice(0, 4) + '…' + s.destination.slice(-4))}`,
      '',
      '🪙 Trading a brand-new token later? I will message you with a one-tap approval the first time it shows up.',
    ].join('\n'),
    { ...HTML, reply_markup: new InlineKeyboard().url('✍️ Approve in my wallet', link) },
  );
}

async function doStatus(ctx: Context) {
  const chatId = ctx.chat!.id;
  const s = getState(chatId);
  const text = formatStatus(s);
  if (!s.authority) {
    await ctx.reply(mdToHtml(text), { ...HTML, reply_markup: mainKb() });
    return;
  }
  const chain = await verifyDelegations(connection, s);
  await ctx.reply(mdToHtml(chain ? `${text}\n\n${chain}` : text), { ...HTML, reply_markup: mainKb() });
}

async function doAccrued(ctx: Context) {
  const s = getState(ctx.chat!.id);
  if (!s.destination) {
    await send(ctx, nextStep(ctx.chat!.id, '🏦 Set your savings wallet first.'));
    return;
  }
  try {
    const bal = await connection.getBalance(new PublicKey(s.destination));
    await ctx.reply(
      `💎 <b>Your savings pot</b> 🐷\n${code(s.destination)}\n\n💰 SOL: <b>${bal / 1e9}</b> ✨\n🪙 Tokens: skim lands as the token you traded — peek in an explorer! 🔍`,
      HTML,
    );
  } catch (e: any) {
    await ctx.reply('💎 Balance check hiccup 😅 — try again in a moment.');
    console.error('accrued error', e?.message);
  }
}

async function doPause(ctx: Context, paused: boolean) {
  const chatId = ctx.chat!.id;
  const s = getState(chatId);
  if (!s.authority) {
    await send(ctx, nextStep(chatId, '🔗 Link a wallet first.'));
    return;
  }
  setPaused(chatId, paused);
  await ctx.reply(
    paused
      ? '⏸️ <b>Saving paused.</b> The keeper will skip your trades until you /resume.\n\n⚠️ Pausing is not revoking: to remove my permission entirely, run /revoke.'
      : '▶️ <b>Saving resumed!</b> 🚀 I will save your cut on your next trade. 💰',
    HTML,
  );
}

// ── commands ─────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  disarm(ctx.chat.id);
  const s = getState(ctx.chat.id);
  await ctx.reply(WELCOME, HTML);
  await send(ctx, nextStep(ctx.chat.id, s.authority ? '👋 Welcome back — here’s where you are:' : ''));
});

bot.command('help', async (ctx) => {
  await ctx.reply(HELP, { ...HTML, reply_markup: mainKb() });
});

bot.command('cancel', async (ctx) => {
  disarm(ctx.chat.id);
  await ctx.reply('👌 Cancelled. Use the menu or /help anytime.', { reply_markup: mainKb() });
});

bot.command('connect', async (ctx) => {
  const arg = ctx.match.toString().trim();
  if (arg) return void (await doConnect(ctx, arg));
  arm(ctx.chat.id, 'connect');
  await ctx.reply('🔗 <b>Paste your wallet address</b> now — just send it as a message. 👇', HTML);
});

bot.command('set_rate', async (ctx) => {
  const arg = ctx.match.toString().trim();
  if (arg) return void (await doRate(ctx, arg));
  arm(ctx.chat.id, 'rate');
  await ctx.reply('💰 <b>What % of each trade should I save?</b> Tap one or type a number (0–10). 👇', { ...HTML, reply_markup: rateKb() });
});

bot.command('set_destination', async (ctx) => {
  const arg = ctx.match.toString().trim();
  if (arg) return void (await doDest(ctx, arg));
  arm(ctx.chat.id, 'dest');
  await ctx.reply('🏦 <b>Paste your savings wallet address</b> now (tip: a separate wallet keeps it untouched 🐷), or tap below.', {
    ...HTML,
    reply_markup: new InlineKeyboard().text('Use my own wallet', 'dest:same'),
  });
});

// Optional/advanced — no longer part of onboarding (approval covers every token you hold).
bot.command('add_mint', async (ctx) => {
  const arg = ctx.match.toString().trim();
  try {
    const mint = parseAddr(arg);
    const added = addMint(ctx.chat.id, mint);
    await ctx.reply(`🪙 ${added ? 'Noted' : 'Already noted'}: ${code(mint)}\n\nYou don’t need this anymore — /spawn_wallet approves every token you hold, and I will prompt you for new ones.`, HTML);
  } catch {
    await ctx.reply('🪙 Optional: <code>/add_mint MINT_ADDRESS</code>. Not needed — I cover every token you trade.', HTML);
  }
});

bot.command('spawn_wallet', doSpawn);
bot.command('status', doStatus);
bot.command('accrued', doAccrued);
bot.command('pause', (ctx) => doPause(ctx, true));
bot.command('resume', (ctx) => doPause(ctx, false));

bot.command('revoke', async (ctx) => {
  const s = getState(ctx.chat.id);
  if (!s.authority) {
    await send(ctx, nextStep(ctx.chat.id, '🔗 Nothing to revoke yet — link a wallet first.'));
    return;
  }
  setPaused(ctx.chat.id, true);
  if (!publicBase()) {
    await ctx.reply('⏸️ Paused. To fully revoke, sign an SPL Revoke on each token account from your wallet.');
    return;
  }
  await ctx.reply(
    '🛑 <b>Revoke</b> — I paused saving. Tap below, connect the same wallet, and sign to remove my keeper’s permission on all your tokens. You can re-enable any time with /spawn_wallet.',
    { ...HTML, reply_markup: new InlineKeyboard().url('🛑 Revoke permission', signUrl(s.authority, '&revoke=1')) },
  );
});

// 🚫 Explicit: no trading surface.
bot.hears(/^\/(buy|sell|swap|trade)\b/i, async (ctx) => {
  await ctx.reply('🚫 No trading here — by design! 😎\n\nTrade on any app 📱, saving happens on its own ✨. Check 📊 /status to peek! 👀');
});

// ── buttons ──────────────────────────────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const d = ctx.callbackQuery.data;
  try {
    await ctx.answerCallbackQuery();
  } catch {
    /* stale query — keep going */
  }
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const [kind, a, b] = d.split(':');
  switch (kind) {
    case 'nav':
      switch (a) {
        case 'connect':
          arm(chatId, 'connect');
          return void (await ctx.reply('🔗 <b>Paste your wallet address</b> now. 👇', HTML));
        case 'rate':
          arm(chatId, 'rate');
          return void (await ctx.reply('💰 <b>What % should I save?</b> Tap or type 0–10. 👇', { ...HTML, reply_markup: rateKb() }));
        case 'dest':
          arm(chatId, 'dest');
          return void (await ctx.reply('🏦 <b>Paste your savings wallet address</b>, or tap below.', { ...HTML, reply_markup: new InlineKeyboard().text('Use my own wallet', 'dest:same') }));
        case 'wallet':
          return void (await doSpawn(ctx));
        case 'status':
          return void (await doStatus(ctx));
        case 'accrued':
          return void (await doAccrued(ctx));
        case 'pause':
          return void (await doPause(ctx, true));
        default:
          return void (await ctx.reply(HELP, HTML));
      }
    case 'rate':
      return void (await doRate(ctx, String(Number(a) / 100)));
    case 'dest':
      if (a === 'same') {
        const s = getState(chatId);
        if (!s.authority) return void (await send(ctx, nextStep(chatId, '🔗 Link your wallet first.')));
        return void (await doDest(ctx, s.authority));
      }
      break;
    case 'use':
      // use:c:<addr> (wallet) · use:d:<addr> (savings) · use:r:<pct> (rate)
      if (a === 'c') return void (await doConnect(ctx, b ?? ''));
      if (a === 'd') return void (await doDest(ctx, b ?? ''));
      if (a === 'r') return void (await doRate(ctx, b ?? ''));
      break;
  }
  await ctx.reply(HELP, HTML);
});

// ── plain text: the part that used to be silently ignored ───────────────────
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;
  if (text.startsWith('/')) {
    await ctx.reply('🤷 I don’t know that command. Here’s what I can do:', { ...HTML, reply_markup: mainKb() });
    await ctx.reply(HELP, HTML);
    return;
  }
  const want = currentAwait(chatId);
  if (want === 'connect') return void (await doConnect(ctx, text));
  if (want === 'rate') return void (await doRate(ctx, text));
  if (want === 'dest') return void (await doDest(ctx, text));

  if (looksLikeAddr(text)) {
    const addr = parseAddr(text);
    const s = getState(chatId);
    const kb = new InlineKeyboard().text(s.authority ? '🔗 My wallet (replace)' : '🔗 My wallet', `use:c:${addr}`);
    kb.row().text('🏦 My savings wallet', `use:d:${addr}`);
    await ctx.reply(`📋 Got an address:\n${code(addr)}\n\nWhat is it for?`, { ...HTML, reply_markup: kb });
    return;
  }
  if (/^\d+(\.\d+)?\s*%?$/.test(text)) {
    try {
      const bps = parseBps(text);
      await ctx.reply(`💰 Set your savings rate to <b>${bpsToPct(bps)}%</b>?`, {
        ...HTML,
        reply_markup: new InlineKeyboard().text(`Yes, ${bpsToPct(bps)}%`, `use:r:${text.replace('%', '').trim()}`),
      });
      return;
    } catch (e: any) {
      await ctx.reply(`💰 ${esc(e.message)}`, { ...HTML, reply_markup: rateKb() });
      return;
    }
  }
  await send(ctx, nextStep(chatId, '🤔 I didn’t catch that.'));
});

bot.on('message', async (ctx) => {
  await ctx.reply('📎 I can only read text. Paste your wallet address or use the menu — /help', { ...HTML, reply_markup: mainKb() });
});

// ── safety nets ──────────────────────────────────────────────────────────────
let commandsRegistered = false;
bot.catch(async (err) => {
  console.error('bot error', err.error);
  try {
    await err.ctx.reply('😅 Something went wrong on my side. Please try again — if it keeps happening, send /start.');
  } catch {
    /* nothing more we can do */
  }
});

/** Registers menu commands once and keeps the bot DM-only. Called before handlers run. */
export function installGuard(b: Bot): void {
  b.use(async (ctx, next) => {
    if (!commandsRegistered) {
      commandsRegistered = true;
      b.api
        .setMyCommands([
          { command: 'start', description: 'Start / where am I?' },
          { command: 'connect', description: 'Link your wallet' },
          { command: 'set_rate', description: 'Set savings %' },
          { command: 'set_destination', description: 'Set savings wallet' },
          { command: 'spawn_wallet', description: 'Approve in your wallet' },
          { command: 'status', description: 'My setup + on-chain check' },
          { command: 'accrued', description: 'Savings balance' },
          { command: 'pause', description: 'Pause saving' },
          { command: 'resume', description: 'Resume saving' },
          { command: 'revoke', description: 'Remove my permission' },
          { command: 'help', description: 'Help' },
        ])
        .catch(() => {});
    }
    if (ctx.chat && ctx.chat.type !== 'private') {
      await ctx.reply('🔒 Please message me in a private chat — wallet setup must not happen in groups.').catch(() => {});
      return;
    }
    try {
      await next();
    } catch (err) {
      console.error('handler error', (err as any)?.message ?? err);
      await ctx
        .reply('😅 Something went wrong on my side. Please try again — if it keeps happening, send /start.')
        .catch(() => {});
    }
  });
}

if (require.main === module) {
  bot.start();
  console.log('skim-telegram online (onboarding+status only, no trading)');
}
export default bot;
