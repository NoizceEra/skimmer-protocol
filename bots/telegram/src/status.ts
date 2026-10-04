import { Connection, PublicKey } from '@solana/web3.js';
import type { UserState } from './store';
import { bpsToPct } from './store';

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? '2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp',
);

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

export function walletPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('smart_wallet'), owner.toBuffer()], PROGRAM_ID);
}

export function configPda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('user_config'), authority.toBuffer()], PROGRAM_ID);
}

function short(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

/**
 * 📊 /status — renders the REAL configured state from the frozen shared store
 * (not an on-chain config PDA, which is never initialised on this rail).
 */
export function formatStatus(s: UserState): string {
  if (!s.authority) {
    return [
      `📊 *Your skim status* 🔍`,
      ``,
      `😴 No wallet linked yet.`,
      ``,
      `👣 Start here:`,
      `1️⃣ 🔗 /connect YOUR_WALLET`,
      `2️⃣ 💰 /set_rate 5`,
      `3️⃣ 🏦 /set_destination SAVINGS_WALLET`,
      `4️⃣ 🪙 /add_mint MINT`,
      `5️⃣ 🚀 /spawn_wallet`,
    ].join('\n');
  }

  const mints = s.approvedMints ?? [];
  const rate = typeof s.savingsBps === 'number' ? `${bpsToPct(s.savingsBps)}% (${s.savingsBps} bps)` : '❌ not set';
  const dest = s.destination ? `\`${s.destination}\`` : '❌ not set';
  const delegate = s.delegate ? `\`${short(s.delegate)}\`` : '❌ not set (KEEPER_DELEGATE missing)';
  const paused = s.paused ? '⏸️ yes' : '▶️ no';
  const wallet = s.wallet ? `\`${s.wallet}\`` : `\`${walletPda(new PublicKey(s.authority))[0].toBase58()}\``;

  const ready = !!s.destination && !!s.delegate && typeof s.savingsBps === 'number' && mints.length > 0;

  return [
    s.paused ? `⏸️ *Saving paused* 😴` : `📊 *Your skim status* ✅`,
    ``,
    `👤 Wallet: \`${s.authority}\``,
    `🚀 Skim wallet PDA: \`${wallet}\``,
    `💰 Rate: *${rate}*`,
    `🏦 Savings pot: ${dest}`,
    `🔑 Keeper delegate: ${delegate}`,
    `⏸️ Paused: ${paused}`,
    `🪙 Mints approved: ${mints.length ? mints.map((m) => `\`${short(m)}\``).join(', ') : '❌ none'}`,
    ``,
    ready
      ? `👉 Run 🚀 /spawn_wallet to (re)issue your one-time approval tx, then trade anywhere! ✨`
      : `👣 Finish setup: ${!s.destination ? '🏦 /set_destination · ' : ''}${!s.savingsBps ? '💰 /set_rate 5 · ' : ''}${mints.length === 0 ? '🪙 /add_mint · ' : ''}🚀 /spawn_wallet`,
  ].join('\n');
}

/**
 * Best-effort on-chain delegate check (read-only). Never throws — a flaky RPC
 * must not break /status. Returns '' when there is nothing to check.
 */
export async function verifyDelegations(connection: Connection, s: UserState): Promise<string> {
  const mints = s.approvedMints ?? [];
  if (!s.authority || mints.length === 0) return '';
  try {
    const owner = new PublicKey(s.authority);
    const resp = await connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    });
    const byMint = new Map<string, any>();
    for (const { account } of resp.value) {
      const info = (account.data as any).parsed?.info;
      if (info?.mint) byMint.set(info.mint, info);
    }
    const lines: string[] = [];
    for (const mint of mints) {
      const info = byMint.get(mint);
      if (!info) {
        lines.push(`• ${short(mint)}: no token account yet — trade it once`);
      } else if (s.delegate && info.delegate === s.delegate) {
        lines.push(`✅ ${short(mint)}: approved, allowance ${info.delegatedAmount ?? '0'}`);
      } else {
        lines.push(`⚠️ ${short(mint)}: not delegated — run 🚀 /spawn_wallet`);
      }
    }
    if (!lines.length) return '';
    return `🔐 *On-chain delegate check:*\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * Legacy helper kept for compatibility. Prefer formatStatus() with the store
 * record; this falls back to an authority-only view.
 */
export async function fetchStatus(
  _connection: Connection,
  authority: PublicKey,
  record?: UserState,
): Promise<string> {
  return formatStatus(record ?? { authority: authority.toBase58() });
}
