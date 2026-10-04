'use strict';
/**
 * Devnet SWAP LIFECYCLE test — v1 SPL-delegation rail (no program needed).
 *
 * Flow: fund keeper -> create test mint -> mint 1000 tokens to user (= simulated
 * swap output sitting in their wallet) -> bounded Approve to keeper ->
 * engine.processSkim -> assert savings got 5% and treasury got 0.4%.
 *
 * Needs: keys/lifecycle-user.json + keys/lifecycle-keeper.json funded with a
 * little devnet SOL (faucet: `solana airdrop 1 <addr> --url devnet`).
 * Exit 0 PASS, 1 FAIL, 2 UNDERFUNDED.
 * Never prints secret keys.
 */
const fs = require('node:fs');

const ROOT = 'D:/ai-studio/skim-protocol';
const web3 = require(ROOT + '/keeper/node_modules/@solana/web3.js');
const spl = require(ROOT + '/keeper/node_modules/@solana/spl-token');

const { Connection, Keypair, PublicKey, Transaction, SystemProgram } = web3;
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const TREASURY = new PublicKey(process.env.TREASURY ?? '85TK12gDB5HEJog6g9Gs7sw9xomrsMfsAy8ZSgGtS3ka');
const SAVINGS_BPS = 500; // 5%
const FEE_BPS = 40; // 0.4%

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const user = load(ROOT + '/keys/lifecycle-user.json');
  const keeper = load(ROOT + '/keys/lifecycle-keeper.json');
  const savings = load(ROOT + '/keys/lifecycle-savings.json');
  console.log('user:', user.publicKey.toBase58());
  console.log('keeper:', keeper.publicKey.toBase58());
  console.log('savings:', savings.publicKey.toBase58());

  const bal = await connection.getBalance(user.publicKey);
  console.log('user balance:', bal / 1e9, 'SOL');
  if (bal < 0.05 * 1e9) {
    console.error('UNDERFUNDED: send devnet SOL to ' + user.publicKey.toBase58());
    process.exit(2);
  }

  // keeper pays sweep tx fees -> fund it from user
  await web3.sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: user.publicKey, toPubkey: keeper.publicKey, lamports: 20_000_000,
    })),
    [user],
  );
  console.log('keeper funded');

  // test mint + 1000 tokens (= simulated swap output) in user ATA
  const mint = await spl.createMint(connection, user, user.publicKey, null, 6);
  console.log('test mint:', mint.toBase58());
  const userAta = await spl.getOrCreateAssociatedTokenAccount(connection, user, mint, user.publicKey);
  await spl.mintTo(connection, user, mint, userAta.address, user.publicKey, 1_000_000_000);
  await spl.getOrCreateAssociatedTokenAccount(connection, user, mint, savings.publicKey);
  await spl.getOrCreateAssociatedTokenAccount(connection, user, mint, TREASURY);
  console.log('minted 1000 tokens to user (trade output simulation)');

  // bounded approve: exactly the output amount, revocable anytime
  await spl.approve(connection, user, userAta.address, keeper.publicKey, user.publicKey, 1_000_000_000);
  console.log('keeper approved (bounded, revocable)');

  const { processSkim } = require(ROOT + '/keeper/dist/engine.js');
  const out = await processSkim({
    connection,
    keeper,
    treasury: TREASURY,
    user: user.publicKey,
    mint,
    outputAmount: 1_000_000_000n,
    decimals: 6,
    swapSignature: 'lifecycle-swap-' + Date.now(),
    savingsBps: SAVINGS_BPS,
    savingsDestination: savings.publicKey,
  });
  console.log('sweep result:', JSON.stringify(out, (_, v) => typeof v === 'bigint' ? v.toString() : v));
  if (out.status !== 'swept') throw new Error('sweep did not happen: ' + out.status + '/' + (out.reason ?? ''));

  const savAta = spl.getAssociatedTokenAddressSync(mint, savings.publicKey);
  const treAta = spl.getAssociatedTokenAddressSync(mint, TREASURY);
  const savBal = await connection.getTokenAccountBalance(savAta);
  const treBal = await connection.getTokenAccountBalance(treAta);
  console.log('savings:', savBal.value.uiAmountString, '| treasury:', treBal.value.uiAmountString);
  if (savBal.value.amount !== '50000000') throw new Error('savings wrong (want 50.0 @5%)');
  if (treBal.value.amount !== '4000000') throw new Error('fee wrong (want 4.0 @0.4%)');

  console.log('DEVNET SWAP LIFECYCLE PASS: approve -> trade-output -> skim 5% + fee 0.4% verified on-chain');
}

main().catch((e) => {
  console.error('LIFECYCLE FAIL:', e.message);
  process.exit(e.message.startsWith('UNDERFUNDED') ? 2 : 1);
});
