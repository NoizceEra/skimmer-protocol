'use strict';
/**
 * Skim Telegram bot — onboarding + status ONLY.
 * No swaps. No buy/sell. Trading happens on other wallets/platforms.
 * This bot: /connect, /set_rate, /set_destination, /spawn_wallet, /status, /accrued, /pause, /resume, /help, /start.
 */
import { Bot, InlineKeyboard } from 'grammy';
import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
dotenv.config();

import { getState, saveState, parseBps, bpsToPct } from './store';
import { fetchStatus, walletPda } from './status';

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in bots/telegram/.env');
  process.exit(1);
}
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC, 'confirmed');
const bot = new Bot(token);

const mainKb = () =>
  new InlineKeyboard().text('Set rate', 'nav:rate').text('Status', 'nav:status').row().text('Help', 'nav:help');

bot.command('start', async (ctx) => {
  await ctx.reply(
    [
      'Skim Protocol — auto-save as a fee.',
      '',
      '1. /connect <your wallet>',
      '2. /set_rate 5  (0–10%)',
      '3. /set_destination <savings wallet>',
      '4. /spawn_wallet (shows your smart-wallet PDA)',
      '',
      'Then trade anywhere. Every trade skims like slippage to your savings.',
      'Use /status to see config, /accrued to see savings balance.',
      '',
      'This bot never trades and never holds keys.',
    ].join('\n'),
    { reply_markup: mainKb() },
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    '/connect <wallet> — link authority\n/set_rate <pct> — e.g. /set_rate 5\n/set_destination <wallet>\n/spawn_wallet — show PDA to fund\n/status — config + wallet\n/accrued — destination balance\n/pause, /resume\n\nNo trading here by design.',
  );
});

bot.command('connect', async (ctx) => {
  const arg = ctx.match.toString().trim();
  try {
    const pk = new PublicKey(arg);
    if (pk.equals(PublicKey.default)) throw new Error('zero address');
    getState(ctx.chat.id).authority = pk.toBase58();
    saveState(ctx.chat.id);
    await ctx.reply(`Connected: ${pk.toBase58()}\nNow /set_rate 5`);
  } catch {
    await ctx.reply('Usage: /connect <your Solana wallet address>');
  }
});

bot.command('set_rate', async (ctx) => {
  try {
    const bps = parseBps(ctx.match.toString());
    getState(ctx.chat.id).savingsBps = bps;
    saveState(ctx.chat.id);
    await ctx.reply(`Savings rate: ${bpsToPct(bps)}% (${bps} bps)\nNow /set_destination <savings wallet>`);
  } catch (e: any) {
    await ctx.reply(e.message ?? 'Usage: /set_rate 5');
  }
});

bot.command('set_destination', async (ctx) => {
  const arg = ctx.match.toString().trim();
  try {
    const pk = new PublicKey(arg);
    getState(ctx.chat.id).destination = pk.toBase58();
    saveState(ctx.chat.id);
    const s = getState(ctx.chat.id);
    await ctx.reply(
      `Destination: ${pk.toBase58()}\nRate: ${s.savingsBps ?? '?'} bps\nUse /spawn_wallet to finish.`,
    );
  } catch {
    await ctx.reply('Usage: /set_destination <savings wallet address>');
  }
});

bot.command('spawn_wallet', async (ctx) => {
  const s = getState(ctx.chat.id);
  if (!s.authority) {
    await ctx.reply('First /connect <wallet>');
    return;
  }
  if (s.savingsBps == null) {
    await ctx.reply('First /set_rate 5');
    return;
  }
  if (!s.destination) {
    await ctx.reply('First /set_destination <addr>');
    return;
  }
  const [pda] = walletPda(new PublicKey(s.authority));
  s.wallet = pda.toBase58();
  saveState(ctx.chat.id);
  await ctx.reply(
    [
      `Your skim wallet (PDA): ${pda.toBase58()}`,
      `Owner: ${s.authority}`,
      `Saves ${bpsToPct(s.savingsBps)}% of every trade output to ${s.destination}`,
      `Fund/trade from this wallet. Fee enforced on-chain as output*bps/10000.`,
      `Sign initialize_smart_wallet in your wallet app — this bot never holds keys.`,
    ].join('\n'),
  );
});

bot.command('status', async (ctx) => {
  const s = getState(ctx.chat.id);
  if (!s.authority) {
    await ctx.reply('Use /connect <wallet> first. Local view: ' + JSON.stringify(s));
    return;
  }
  try {
    const text = await fetchStatus(connection, new PublicKey(s.authority));
    await ctx.reply(text);
  } catch (e: any) {
    await ctx.reply('Status failed: ' + e.message);
  }
});

bot.command('accrued', async (ctx) => {
  const s = getState(ctx.chat.id);
  if (!s.destination) {
    await ctx.reply('Set /set_destination first, then I can check its SOL balance.');
    return;
  }
  try {
    const bal = await connection.getBalance(new PublicKey(s.destination));
    await ctx.reply(`Savings ${s.destination}\nSOL: ${bal / 1e9}\n(Token mints: check explorer — skim lands as output mint.)`);
  } catch (e: any) {
    await ctx.reply('Balance check failed: ' + e.message);
  }
});

bot.command('pause', async (ctx) => {
  await ctx.reply('To pause: sign set_paused(true) on your user_config PDA in your wallet. Bot does not hold keys, so it cannot pause for you.');
});

bot.command('resume', async (ctx) => {
  await ctx.reply('To resume: sign set_paused(false) on your user_config PDA in your wallet.');
});

// Explicit: no trading surface.
bot.hears(/^\/(buy|sell|swap|trade)\b/i, async (ctx) => {
  await ctx.reply('Trading is disabled here by design. Trade on any platform — skim applies automatically. Use /status to verify.');
});

bot.on('callback_query:data', async (ctx) => {
  const d = ctx.callbackQuery.data;
  if (d === 'nav:status') {
    const s = getState(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(s.authority ? 'Use /status for on-chain view.' : 'Use /connect first.');
  } else if (d === 'nav:rate') {
    await ctx.answerCallbackQuery();
    await ctx.reply('Use /set_rate 5 (means 5%). Max 10%.');
  } else {
    await ctx.answerCallbackQuery();
    await ctx.reply('Use /help.');
  }
});

bot.catch((err) => console.error('bot error', err));

if (require.main === module) {
  bot.start();
  console.log('skim-telegram online (onboarding+status only, no trading)');
}
export default bot;
