'use strict';
/**
 * Devnet lifecycle test for Skimmer Protocol.
 * Steps: fund user -> initialize_smart_wallet -> initialize_config -> read back PDAs
 *        -> create test SPL mint -> fund user ATA -> approve keeper -> processSkim -> verify.
 * Needs: program deployed on devnet, user wallet funded. Exits non-zero on failure.
 * Never prints secret keys.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const ROOT = 'D:/ai-studio/skim-protocol';
const web3 = require(ROOT + '/keeper/node_modules/@solana/web3.js');
const spl = require(ROOT + '/keeper/node_modules/@solana/spl-token');

const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } = web3;

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? '2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp');
const TREASURY = new PublicKey(process.env.TREASURY ?? '85TK12gDB5HEJog6g9Gs7sw9xomrsMfsAy8ZSgGtS3ka');
const SAVINGS_BPS = 500; // 5%
const FEE_BPS = 40; // 0.4%

const disc = (name) => crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8);

function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const progInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (!progInfo || !progInfo.executable) throw new Error('program not deployed on devnet yet: ' + PROGRAM_ID.toBase58());
  console.log('program live:', PROGRAM_ID.toBase58(), progInfo.data.length, 'bytes');

  // 1. user + savings wallets
  const userPath = ROOT + '/keys/user-devnet.json';
  let user;
  if (fs.existsSync(userPath)) {
    user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(userPath, 'utf8'))));
  } else {
    user = Keypair.generate();
    fs.writeFileSync(userPath, JSON.stringify(Array.from(user.secretKey)));
  }
  const savings = Keypair.generate();
  console.log('user:', user.publicKey.toBase58());
  const bal = await connection.getBalance(user.publicKey);
  console.log('user balance:', bal / 1e9, 'SOL');
  if (bal < 0.05 * 1e9) throw new Error('user underfunded — airdrop devnet SOL first');

  // 2. initialize_smart_wallet
  const [walletPda] = PublicKey.findProgramAddressSync([Buffer.from('smart_wallet'), user.publicKey.toBuffer()], PROGRAM_ID);
  const ixData = Buffer.concat([disc('initialize_smart_wallet'), TREASURY.toBuffer(), savings.publicKey.toBuffer(), u16le(FEE_BPS), u16le(SAVINGS_BPS)]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  });
  const tx = new Transaction().add(ix);
  const sig1 = await web3.sendAndConfirmTransaction(connection, tx, [user]);
  console.log('initialize_smart_wallet:', sig1);

  // 3. initialize_config
  const [cfgPda] = PublicKey.findProgramAddressSync([Buffer.from('user_config'), user.publicKey.toBuffer()], PROGRAM_ID);
  const cfgData = Buffer.concat([disc('initialize_config'), walletPda.toBuffer(), savings.publicKey.toBuffer(), u16le(SAVINGS_BPS)]);
  const ix2 = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: cfgPda, isSigner: false, isWritable: true },
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: cfgData,
  });
  const sig2 = await web3.sendAndConfirmTransaction(connection, new Transaction().add(ix2), [user]);
  console.log('initialize_config:', sig2);

  // 4. read back SmartWallet
  const wInfo = await connection.getAccountInfo(walletPda);
  if (!wInfo) throw new Error('wallet PDA missing after init');
  const savBps = wInfo.data.readUInt16LE(8 + 32 + 32 + 32);
  const feeBps = wInfo.data.readUInt16LE(8 + 32 + 32 + 32 + 2);
  console.log('wallet on-chain: savings_bps=' + savBps, 'fee_bps=' + feeBps);
  if (savBps !== SAVINGS_BPS || feeBps !== FEE_BPS) throw new Error('rate mismatch on-chain!');

  // 5. test mint -> fund -> approve -> sweep (full skim lifecycle on SPL)
  const keeper = Keypair.generate();
  // keeper pays sweep tx fees -> fund it; treasury ATA must exist for the fee leg
  const fundTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: keeper.publicKey, lamports: 20_000_000 }),
  );
  await web3.sendAndConfirmTransaction(connection, fundTx, [user]);
  const mint = await spl.createMint(connection, user, user.publicKey, null, 6);
  console.log('test mint:', mint.toBase58());
  await spl.getOrCreateAssociatedTokenAccount(connection, user, mint, TREASURY);
  const userAta = await spl.getOrCreateAssociatedTokenAccount(connection, user, mint, user.publicKey);
  await spl.mintTo(connection, user, mint, userAta.address, user.publicKey, 1_000_000_000); // 1000 tokens
  const keeperAta = await spl.getOrCreateAssociatedTokenAccount(connection, user, mint, keeper.publicKey);
  void keeperAta;
  await spl.approve(connection, user, userAta.address, keeper.publicKey, user.publicKey, 1_000_000_000);
  console.log('keeper approved');

  const { processSkim } = require(ROOT + '/keeper/dist/sweeper.js');
  const out = await processSkim({
    connection,
    keeper,
    treasury: TREASURY,
    user: user.publicKey,
    mint,
    outputAmount: 1_000_000_000n,
    decimals: 6,
    savingsBps: SAVINGS_BPS,
    savingsDestination: savings.publicKey,
    paused: false,
    swapSignature: 'lifecycle-test-' + Date.now(),
  });
  console.log('sweep result:', JSON.stringify(out));
  if (!out.signature) throw new Error('sweep skipped: ' + out.skipped);

  const savAta = spl.getAssociatedTokenAddressSync(mint, savings.publicKey);
  const savBal = await connection.getTokenAccountBalance(savAta).catch(() => null);
  console.log('savings ATA balance:', savBal ? savBal.value.uiAmountString : 'MISSING');
  if (!savBal || BigInt(savBal.value.amount) !== 50_000_000n) throw new Error('skim amount wrong (want 50 tokens @5%)');

  console.log('LIFECYCLE PASS: onboard -> configure -> trade-proxy -> skim -> verified');
}

main().catch((e) => {
  console.error('LIFECYCLE FAIL:', e.message);
  process.exit(1);
});
