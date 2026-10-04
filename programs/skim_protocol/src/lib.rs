use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp");

const MAX_SAVINGS_BPS: u16 = 1000; // 10%
const MAX_FEE_BPS: u16 = 1000; // 10%
const BPS_DENOM: u64 = 10_000;

/// Max per-tx spend for a session (base units). Grants may be less.
pub const ABS_MAX_PER_TX: u64 = 1_000_000_000_000;
/// Max session window: 216_000 slots ~= 24h. Session keys are burners.
pub const MAX_SESSION_SLOTS: u64 = 216_000;

#[program]
pub mod skim_protocol {
    use super::*;

    /// Tag the signer: one UserSavingsConfig PDA per authority.
    /// Used by the fallback detect-then-sweep rail (SPL delegation + listener).
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        smart_wallet: Pubkey,
        savings_destination: Pubkey,
        savings_bps: u16,
    ) -> Result<()> {
        require!(savings_bps <= MAX_SAVINGS_BPS, ErrCode::BadRate);
        require!(savings_destination != Pubkey::default(), ErrCode::BadDest);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.smart_wallet = smart_wallet;
        c.savings_destination = savings_destination;
        c.savings_bps = savings_bps;
        c.paused = false;
        c.bump = ctx.bumps.config;
        msg!("config: {} bps -> {}", savings_bps, savings_destination);
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_destination: Option<Pubkey>,
        new_bps: Option<u16>,
    ) -> Result<()> {
        let c = &mut ctx.accounts.config;
        if let Some(d) = new_destination {
            require!(d != Pubkey::default(), ErrCode::BadDest);
            c.savings_destination = d;
        }
        if let Some(b) = new_bps {
            require!(b <= MAX_SAVINGS_BPS, ErrCode::BadRate);
            c.savings_bps = b;
        }
        msg!("config updated: {} bps -> {}", c.savings_bps, c.savings_destination);
        Ok(())
    }

    pub fn set_paused(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        msg!("skim {}", if paused { "paused" } else { "resumed" });
        Ok(())
    }

    /// Spawn the program-owned smart wallet with the fee hardwired.
    /// PDA seeds: [b"smart_wallet", owner]. Owner is the ONLY grant/revoke key.
    pub fn initialize_smart_wallet(
        ctx: Context<InitWallet>,
        treasury: Pubkey,
        savings_destination: Pubkey,
        protocol_fee_bps: u16,
        savings_bps: u16,
    ) -> Result<()> {
        require!(savings_destination != Pubkey::default(), ErrCode::BadDest);
        require!(treasury != Pubkey::default(), ErrCode::BadTreasury);
        require!(protocol_fee_bps <= MAX_FEE_BPS, ErrCode::BadFee);
        require!(savings_bps <= MAX_SAVINGS_BPS, ErrCode::BadRate);
        require!(
            (protocol_fee_bps as u32) + (savings_bps as u32) <= BPS_DENOM as u32,
            ErrCode::RateTooHigh
        );
        let w = &mut ctx.accounts.smart_wallet;
        w.recovery_authority = ctx.accounts.owner.key();
        w.treasury = treasury;
        w.savings_destination = savings_destination;
        w.protocol_fee_bps = protocol_fee_bps;
        w.savings_bps = savings_bps;
        w.session_count = 0;
        w.paused = false;
        w.bump = ctx.bumps.smart_wallet;
        msg!("wallet: owner={} fee={} save={}", w.recovery_authority, protocol_fee_bps, savings_bps);
        Ok(())
    }

    pub fn update_wallet(
        ctx: Context<UpdateWallet>,
        new_destination: Option<Pubkey>,
        new_treasury: Option<Pubkey>,
        new_fee_bps: Option<u16>,
        new_savings_bps: Option<u16>,
    ) -> Result<()> {
        let w = &mut ctx.accounts.smart_wallet;
        if let Some(d) = new_destination {
            require!(d != Pubkey::default(), ErrCode::BadDest);
            w.savings_destination = d;
        }
        if let Some(t) = new_treasury {
            require!(t != Pubkey::default(), ErrCode::BadTreasury);
            w.treasury = t;
        }
        let fee = match new_fee_bps {
            Some(v) => { require!(v <= MAX_FEE_BPS, ErrCode::BadFee); v }
            None => w.protocol_fee_bps,
        };
        let sav = match new_savings_bps {
            Some(v) => { require!(v <= MAX_SAVINGS_BPS, ErrCode::BadRate); v }
            None => w.savings_bps,
        };
        require!((fee as u32) + (sav as u32) <= BPS_DENOM as u32, ErrCode::RateTooHigh);
        w.protocol_fee_bps = fee;
        w.savings_bps = sav;
        msg!("wallet updated: fee={} save={}", fee, sav);
        Ok(())
    }

    pub fn set_wallet_paused(ctx: Context<UpdateWallet>, paused: bool) -> Result<()> {
        ctx.accounts.smart_wallet.paused = paused;
        msg!("wallet {}", if paused { "paused" } else { "resumed" });
        Ok(())
    }

    /// Grant a scoped, time-boxed session key. Authority only.
    pub fn grant_session(
        ctx: Context<GrantSession>,
        session_pubkey: Pubkey,
        scope: SessionScope,
        expires_at_slot: u64,
        max_amount_per_tx: u64,
        max_total_amount: u64,
        allowed_mints: Vec<Pubkey>,
        allowed_programs: Vec<Pubkey>,
    ) -> Result<()> {
        require!(session_pubkey != Pubkey::default(), ErrCode::BadSession);
        require!(session_pubkey != ctx.accounts.smart_wallet.key(), ErrCode::BadSession);
        require!(session_pubkey != ctx.accounts.smart_wallet.recovery_authority, ErrCode::BadSession);
        require!(max_amount_per_tx > 0, ErrCode::BadCap);
        require!(max_amount_per_tx <= ABS_MAX_PER_TX, ErrCode::BadCap);
        require!(max_total_amount >= max_amount_per_tx, ErrCode::BadCap);
        let now = Clock::get()?.slot;
        require!(expires_at_slot > now, ErrCode::BadExpiry);
        require!(expires_at_slot <= now.saturating_add(MAX_SESSION_SLOTS), ErrCode::BadExpiry);
        require!(!allowed_programs.is_empty(), ErrCode::BadAllowlist);
        require!(allowed_mints.len() <= 16, ErrCode::BadAllowlist);
        require!(allowed_programs.len() <= 16, ErrCode::BadAllowlist);

        let s = &mut ctx.accounts.session;
        s.smart_wallet = ctx.accounts.smart_wallet.key();
        s.session_pubkey = session_pubkey;
        s.scope = scope;
        s.expires_at_slot = expires_at_slot;
        s.max_amount_per_tx = max_amount_per_tx;
        s.max_total_amount = max_total_amount;
        s.spent = 0;
        s.allowed_mints = allowed_mints.clone();
        s.allowed_programs = allowed_programs.clone();
        s.revoked = false;
        s.bump = ctx.bumps.session;

        ctx.accounts.smart_wallet.session_count =
            ctx.accounts.smart_wallet.session_count.saturating_add(1);
        msg!("session granted: {}", session_pubkey);
        Ok(())
    }

    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        require!(!ctx.accounts.session.revoked, ErrCode::AlreadyRevoked);
        ctx.accounts.session.revoked = true;
        ctx.accounts.smart_wallet.session_count =
            ctx.accounts.smart_wallet.session_count.saturating_sub(1);
        msg!("session revoked: {}", ctx.accounts.session.session_pubkey);
        Ok(())
    }

    /// Enforcement point. Amount is COMPUTED from output_amount * stored bps.
    /// Dest ATAs are derived on-chain — caller cannot redirect or underpay.
    pub fn session_consume(
        ctx: Context<SessionConsume>,
        op: SessionOp,
        mint: Pubkey,
        target_program: Pubkey,
        output_amount: u64,
        amount: u64,
    ) -> Result<()> {
        let now = Clock::get()?.slot;
        let allowed = match op {
            SessionOp::JupiterSwap => ctx.accounts.session.scope.allow_jupiter_swap,
            SessionOp::SkimToSavings => ctx.accounts.session.scope.allow_skim_to_savings,
            SessionOp::ProtocolFee => ctx.accounts.session.scope.allow_protocol_fee,
        };
        require!(allowed, ErrCode::OpDenied);
        require!(ctx.accounts.session.allowed_mints.contains(&mint), ErrCode::MintDenied);
        require!(ctx.accounts.session.allowed_programs.contains(&target_program), ErrCode::ProgDenied);
        require!(amount > 0, ErrCode::BadAmount);
        require!(amount <= ctx.accounts.session.max_amount_per_tx, ErrCode::CapExceeded);

        let wallet_key = ctx.accounts.smart_wallet.key();
        let treasury_key = ctx.accounts.smart_wallet.treasury;
        let savings_key = ctx.accounts.smart_wallet.savings_destination;
        let fee_bps = ctx.accounts.smart_wallet.protocol_fee_bps;
        let sav_bps = ctx.accounts.smart_wallet.savings_bps;

        let session = &mut ctx.accounts.session;
        require!(!session.revoked, ErrCode::Revoked);
        require!(now <= session.expires_at_slot, ErrCode::Expired);
        require!(!ctx.accounts.smart_wallet.paused, ErrCode::Paused);
        require_keys_eq!(session.smart_wallet, wallet_key, ErrCode::WalletMismatch);

        match op {
            SessionOp::ProtocolFee => {
                require!(ctx.accounts.mint.key() == mint, ErrCode::MintMismatch);
                require_keys_eq!(
                    ctx.accounts.fee_source.key(),
                    get_associated_token_address(&wallet_key, &mint),
                    ErrCode::BadSource
                );
                require_keys_eq!(
                    ctx.accounts.fee_destination.key(),
                    get_associated_token_address(&treasury_key, &mint),
                    ErrCode::BadDestAta
                );
                let expected = (output_amount as u128) * (fee_bps as u128) / (BPS_DENOM as u128);
                require!(amount as u128 == expected, ErrCode::FeeMismatch);
                let seeds: &[&[u8]] = &[
                    b"smart_wallet",
                    ctx.accounts.smart_wallet.recovery_authority.as_ref(),
                    &[ctx.accounts.smart_wallet.bump],
                ];
                transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.fee_source.to_account_info(),
                            mint: ctx.accounts.mint.to_account_info(),
                            to: ctx.accounts.fee_destination.to_account_info(),
                            authority: ctx.accounts.smart_wallet.to_account_info(),
                        },
                        &[seeds],
                    ),
                    amount,
                    ctx.accounts.mint.decimals,
                )?;
                msg!("fee enforced: {} ({} bps of {})", amount, fee_bps, output_amount);
            }
            SessionOp::SkimToSavings => {
                require!(ctx.accounts.mint.key() == mint, ErrCode::MintMismatch);
                require_keys_eq!(
                    ctx.accounts.fee_source.key(),
                    get_associated_token_address(&wallet_key, &mint),
                    ErrCode::BadSource
                );
                require_keys_eq!(
                    ctx.accounts.fee_destination.key(),
                    get_associated_token_address(&savings_key, &mint),
                    ErrCode::BadDestAta
                );
                let expected = (output_amount as u128) * (sav_bps as u128) / (BPS_DENOM as u128);
                require!(amount as u128 == expected, ErrCode::SkimMismatch);
                let seeds: &[&[u8]] = &[
                    b"smart_wallet",
                    ctx.accounts.smart_wallet.recovery_authority.as_ref(),
                    &[ctx.accounts.smart_wallet.bump],
                ];
                transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.fee_source.to_account_info(),
                            mint: ctx.accounts.mint.to_account_info(),
                            to: ctx.accounts.fee_destination.to_account_info(),
                            authority: ctx.accounts.smart_wallet.to_account_info(),
                        },
                        &[seeds],
                    ),
                    amount,
                    ctx.accounts.mint.decimals,
                )?;
                msg!("skim enforced: {} ({} bps of {})", amount, sav_bps, output_amount);
            }
            SessionOp::JupiterSwap => {
                msg!("swap authorized (no value leg here)");
            }
        }

        let s = &mut ctx.accounts.session;
        let new_spent = s.spent.checked_add(amount).ok_or(ErrCode::Overflow)?;
        require!(new_spent <= s.max_total_amount, ErrCode::CapExceeded);
        s.spent = new_spent;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(init, payer = authority, space = 8 + UserSavingsConfig::INIT_SPACE,
        seeds = [b"user_config", authority.key().as_ref()], bump)]
    pub config: Account<'info, UserSavingsConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [b"user_config", authority.key().as_ref()],
        bump = config.bump, has_one = authority @ ErrCode::Unauthorized)]
    pub config: Account<'info, UserSavingsConfig>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct UserSavingsConfig {
    pub authority: Pubkey,
    pub smart_wallet: Pubkey,
    pub savings_destination: Pubkey,
    pub savings_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace)]
pub struct SessionScope {
    pub allow_jupiter_swap: bool,
    pub allow_skim_to_savings: bool,
    pub allow_protocol_fee: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SessionOp {
    JupiterSwap,
    SkimToSavings,
    ProtocolFee,
}

#[account]
#[derive(InitSpace)]
pub struct SmartWallet {
    pub recovery_authority: Pubkey,
    pub treasury: Pubkey,
    pub savings_destination: Pubkey,
    pub protocol_fee_bps: u16,
    pub savings_bps: u16,
    pub session_count: u32,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SessionKey {
    pub smart_wallet: Pubkey,
    pub session_pubkey: Pubkey,
    pub scope: SessionScope,
    pub expires_at_slot: u64,
    pub max_amount_per_tx: u64,
    pub max_total_amount: u64,
    pub spent: u64,
    #[max_len(16)]
    pub allowed_mints: Vec<Pubkey>,
    #[max_len(16)]
    pub allowed_programs: Vec<Pubkey>,
    pub revoked: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitWallet<'info> {
    #[account(init, payer = owner, space = 8 + SmartWallet::INIT_SPACE,
        seeds = [b"smart_wallet", owner.key().as_ref()], bump)]
    pub smart_wallet: Account<'info, SmartWallet>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(session_pubkey: Pubkey)]
pub struct GrantSession<'info> {
    #[account(mut, seeds = [b"smart_wallet", smart_wallet.recovery_authority.as_ref()],
        bump = smart_wallet.bump, has_one = recovery_authority @ ErrCode::Unauthorized)]
    pub smart_wallet: Account<'info, SmartWallet>,
    #[account(init, payer = recovery_authority, space = 8 + SessionKey::INIT_SPACE,
        seeds = [b"session", smart_wallet.key().as_ref(), session_pubkey.as_ref()], bump)]
    pub session: Account<'info, SessionKey>,
    #[account(mut)]
    pub recovery_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    #[account(mut, seeds = [b"smart_wallet", smart_wallet.recovery_authority.as_ref()],
        bump = smart_wallet.bump, has_one = recovery_authority @ ErrCode::Unauthorized)]
    pub smart_wallet: Account<'info, SmartWallet>,
    #[account(mut, seeds = [b"session", smart_wallet.key().as_ref(), session.session_pubkey.as_ref()],
        bump = session.bump, has_one = smart_wallet @ ErrCode::WalletMismatch)]
    pub session: Account<'info, SessionKey>,
    #[account(mut)]
    pub recovery_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateWallet<'info> {
    #[account(mut, seeds = [b"smart_wallet", smart_wallet.recovery_authority.as_ref()],
        bump = smart_wallet.bump, has_one = recovery_authority @ ErrCode::Unauthorized)]
    pub smart_wallet: Account<'info, SmartWallet>,
    pub recovery_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SessionConsume<'info> {
    #[account(seeds = [b"smart_wallet", smart_wallet.recovery_authority.as_ref()],
        bump = smart_wallet.bump)]
    pub smart_wallet: Box<Account<'info, SmartWallet>>,
    #[account(mut, seeds = [b"session", smart_wallet.key().as_ref(), session.session_pubkey.as_ref()],
        bump = session.bump, has_one = smart_wallet @ ErrCode::WalletMismatch,
        constraint = session.session_pubkey == session_authority.key() @ ErrCode::WrongSigner)]
    pub session: Box<Account<'info, SessionKey>>,
    pub session_authority: Signer<'info>,
    #[account(mut)]
    pub fee_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub fee_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum ErrCode {
    #[msg("rate must be 0-1000 bps")]
    BadRate,
    #[msg("bad destination")]
    BadDest,
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("bad treasury")]
    BadTreasury,
    #[msg("bad protocol fee")]
    BadFee,
    #[msg("combined rate exceeds 10000 bps")]
    RateTooHigh,
    #[msg("bad session key")]
    BadSession,
    #[msg("bad cap")]
    BadCap,
    #[msg("bad expiry")]
    BadExpiry,
    #[msg("bad allowlist")]
    BadAllowlist,
    #[msg("already revoked")]
    AlreadyRevoked,
    #[msg("op not in scope")]
    OpDenied,
    #[msg("mint not allowed")]
    MintDenied,
    #[msg("program not allowed")]
    ProgDenied,
    #[msg("amount must be > 0")]
    BadAmount,
    #[msg("cap exceeded")]
    CapExceeded,
    #[msg("revoked")]
    Revoked,
    #[msg("expired")]
    Expired,
    #[msg("wallet paused")]
    Paused,
    #[msg("wallet mismatch")]
    WalletMismatch,
    #[msg("overflow")]
    Overflow,
    #[msg("wrong session signer")]
    WrongSigner,
    #[msg("mint mismatch")]
    MintMismatch,
    #[msg("bad fee source (must be wallet ATA)")]
    BadSource,
    #[msg("bad fee destination ATA")]
    BadDestAta,
    #[msg("fee != output*fee_bps/10000")]
    FeeMismatch,
    #[msg("skim != output*savings_bps/10000")]
    SkimMismatch,
}
