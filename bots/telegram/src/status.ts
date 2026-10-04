import { Connection, PublicKey } from '@solana/web3.js';

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? '2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp',
);

export function walletPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('smart_wallet'), owner.toBuffer()], PROGRAM_ID);
}

export function configPda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('user_config'), authority.toBuffer()], PROGRAM_ID);
}

/** Read on-chain status for /status. No trading, read-only. */
export async function fetchStatus(
  connection: Connection,
  authority: PublicKey,
): Promise<string> {
  const [cfg] = configPda(authority);
  const [wallet] = walletPda(authority);
  const cfgInfo = await connection.getAccountInfo(cfg);
  if (!cfgInfo) {
    return [
      `No skim config yet.`,
      `Wallet: ${authority.toBase58()}`,
      `Expected smart wallet: ${wallet.toBase58()}`,
      `Use /set_rate 5 then /set_destination <addr> then /spawn_wallet.`,
    ].join('\n');
  }
  const bps = cfgInfo.data.readUInt16LE(8 + 32 + 32 + 32);
  const paused = cfgInfo.data.readUInt8(8 + 32 + 32 + 32 + 2) === 1;
  const dest = new PublicKey(cfgInfo.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32)).toBase58();
  return [
    `Skim: ${bps / 100}% (${bps} bps) ${paused ? '[PAUSED]' : ''}`,
    `Destination: ${dest}`,
    `Smart wallet: ${wallet.toBase58()}`,
    `Trade anywhere — every trade auto-skims like a fee. Check destination balances for accrued total.`,
  ].join('\n');
}
