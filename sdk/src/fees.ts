import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

export const PROTOCOL_FEE_BPS = 40; // 0.4%
export const TREASURY = new PublicKey(
  process.env.TREASURY ?? '85TK12gDB5HEJog6g9Gs7sw9xomrsMfsAy8ZSgGtS3ka',
);

export function feeFor(amountLamports: bigint): bigint {
  return (amountLamports * BigInt(PROTOCOL_FEE_BPS)) / 10000n;
}

/** Deposit to savings vault: fee to treasury, rest to vault. Caller signs. */
export function buildDepositTx(params: {
  from: PublicKey;
  vault: PublicKey;
  amountLamports: bigint;
  treasury?: PublicKey;
}): Transaction {
  const treasury = params.treasury ?? TREASURY;
  const fee = feeFor(params.amountLamports);
  const net = params.amountLamports - fee;
  if (net <= 0n) throw new Error('amount too small after 0.4% fee');
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({ fromPubkey: params.from, toPubkey: treasury, lamports: Number(fee) }),
    SystemProgram.transfer({ fromPubkey: params.from, toPubkey: params.vault, lamports: Number(net) }),
  );
  return tx;
}

/** Withdraw from vault: fee to treasury, rest to user. Vault authority signs via program/keeper. */
export function buildWithdrawTx(params: {
  vault: PublicKey;
  to: PublicKey;
  amountLamports: bigint;
  treasury?: PublicKey;
}): { fee: bigint; net: bigint; memo: string } {
  const treasury = params.treasury ?? TREASURY;
  const fee = feeFor(params.amountLamports);
  const net = params.amountLamports - fee;
  if (net <= 0n) throw new Error('amount too small after 0.4% fee');
  return { fee, net, memo: `withdraw ${net} to ${params.to.toBase58()}, fee ${fee} to ${treasury.toBase58()}` };
}
