use anchor_lang::error_code;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption::Some as CSome;
use anchor_safe_math::SafeMath;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("7VWcjkxeQNAnb9PDTkXYxP3oSFxXEiYUMBStn39rr4PX");

const INIT_MAGIC_NUMBER: u64 = 0x6666;

#[error_code]
enum PoolError {
    #[msg("Invalid mint")]
    InvalidMint,

    #[msg("Invalid vault")]
    InvalidVault,

    #[msg("Invalid mint program signer")]
    InvalidProgramSigner,

    #[msg("Invalid user mint account")]
    InvalidUserMintAccount,

    #[msg("User not initialized")]
    UserNotInitialized,

    #[msg("Zero amount")]
    ZeroAmount,
}

type PoolResult<T = ()> = Result<T>;

#[account(zero_copy)]
pub struct Pool {
    pub magic: u64,

    /// Program signer
    pub program_signer: Pubkey,

    /// The mint of the SPL token staked in.
    pub mint: Pubkey,

    /// Address of the account's token vault.
    pub vault: Pubkey,

    /// Staked total
    pub staked_total: u64,

    /// Program singer nonce.
    pub nonce: u8,

    pub padding: [u8; 7],
}

#[account]
pub struct UserState {
    pub initialized: bool,
    pub staked_amount: u64,
}

impl UserState {
    pub fn size() -> usize {
        std::mem::size_of::<UserState>()
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(zero)]
    pub pool: AccountLoader<'info, Pool>,

    /// CHECK:
    #[account(constraint= mint.mint_authority == CSome(program_signer.key()) && mint.freeze_authority == CSome(authority.key()))]
    mint: Box<Account<'info, Mint>>,

    /// CHECK:
    pub program_signer: AccountInfo<'info>,

    /// CHECK: staking vault
    #[account(constraint = vault.mint == mint.key() && vault.owner == program_signer.key()  @PoolError::InvalidVault)]
    vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AirDrop<'info> {
    #[account(owner = *__program_id )]
    pub pool: AccountLoader<'info, Pool>,

    /// CHECK
    pub program_signer: AccountInfo<'info>,

    /// CHECK:
    #[account(mut)]
    mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = (user_mint_acc.owner == *authority.key)
    )]
    pub user_mint_acc: Box<Account<'info, TokenAccount>>,

    /// CHECK
    pub authority: Signer<'info>,

    /// CHECK
    #[account(executable, constraint = (token_program.key == &token::ID))]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct InitializeUserState<'info> {
    /// CHECK
    #[account(
        init,
        seeds = [pool.key().as_ref(), authority.key.as_ref()],
        bump,
        payer = authority,
        space = 8 + UserState::size()
    )]
    pub user_state: Account<'info, UserState>,
    // pub user_state: UncheckedAccount<'info>,
    /// CHECK
    pub pool: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnterStaking<'info> {
    #[account(mut, owner = *__program_id )]
    pub pool: AccountLoader<'info, Pool>,

    /// CHECK
    mint: AccountInfo<'info>,

    /// CHECK
    #[account(mut)]
    vault: AccountInfo<'info>,

    #[account(
         mut,
         constraint = (user_mint_acc.owner == *authority.key && user_mint_acc.mint == *mint.key)
     )]
    user_mint_acc: Box<Account<'info, TokenAccount>>,

    /// CHECK
    #[account(mut, seeds = [pool.key().as_ref(), authority.key().as_ref()], bump, owner = *__program_id)]
    pub user_state: Account<'info, UserState>,

    /// CHECK
    pub authority: Signer<'info>,

    /// CHECK
    #[account(executable, constraint = (token_program.key == &token::ID))]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct LeaveStaking<'info> {
    #[account(mut, owner = *__program_id )]
    pub pool: AccountLoader<'info, Pool>,

    /// CHECK
    pub program_signer: AccountInfo<'info>,

    /// CHECK
    mint: AccountInfo<'info>,

    /// CHECK
    #[account(mut)]
    vault: AccountInfo<'info>,

    #[account(
         mut,
         constraint = (user_mint_acc.owner == *authority.key && user_mint_acc.mint == *mint.key)
     )]
    user_mint_acc: Box<Account<'info, TokenAccount>>,

    /// CHECK
    #[account(mut, seeds = [pool.key().as_ref(), authority.key().as_ref()], bump, owner = *__program_id)]
    pub user_state: Account<'info, UserState>,

    /// CHECK
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

fn handle_initialize(ctx: Context<Initialize>, nonce: u8) -> PoolResult {
    let (program_signer, nonce_found) = Pubkey::find_program_address(
        &[
            &ctx.accounts.mint.key().to_bytes(),
            &ctx.accounts.pool.to_account_info().key.to_bytes(),
        ],
        ctx.program_id,
    );

    require!(
        nonce == nonce_found && ctx.accounts.program_signer.key() == program_signer,
        PoolError::InvalidProgramSigner
    );

    let pool = &mut ctx.accounts.pool.load_init()?;

    pool.magic = INIT_MAGIC_NUMBER;
    pool.mint = ctx.accounts.mint.key();
    pool.vault = ctx.accounts.vault.key();
    pool.program_signer = program_signer;
    pool.nonce = nonce;

    Ok(())
}

fn handle_airdrop(ctx: Context<AirDrop>, amount: u64) -> PoolResult {
    let pool = &ctx.accounts.pool.load()?;

    require!(pool.mint == ctx.accounts.mint.key(), PoolError::InvalidMint);

    require!(
        pool.program_signer == ctx.accounts.program_signer.key(),
        PoolError::InvalidProgramSigner
    );

    require!(
        pool.mint == ctx.accounts.user_mint_acc.mint,
        PoolError::InvalidUserMintAccount
    );

    let seeds = &[
        pool.mint.as_ref(),
        ctx.accounts.pool.to_account_info().key.as_ref(),
        &[pool.nonce],
    ];

    let signer = &[&seeds[..]];

    let cpi_accounts = MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.user_mint_acc.to_account_info(),
        authority: ctx.accounts.program_signer.to_account_info(),
    };
    let cpi_ctx =
        CpiContext::new_with_signer(ctx.accounts.token_program.clone(), cpi_accounts, signer);

    token::mint_to(cpi_ctx, amount)?;

    Ok(())
}

fn handle_initialize_user_state(ctx: Context<InitializeUserState>) -> PoolResult {
    ctx.accounts.user_state.initialized = true;
    ctx.accounts.user_state.staked_amount = 0u64;

    Ok(())
}

fn handle_enter_staking(ctx: Context<EnterStaking>, amount: u64) -> PoolResult {
    let pool = &mut ctx.accounts.pool.load_mut()?;

    require!(amount > 0, PoolError::ZeroAmount);
    require_eq!(pool.mint, ctx.accounts.mint.key(), PoolError::InvalidMint);
    require_eq!(
        pool.vault,
        ctx.accounts.vault.key(),
        PoolError::InvalidVault
    );

    require!(
        ctx.accounts.user_state.initialized,
        PoolError::UserNotInitialized
    );

    let cpi_accounts = Transfer {
        from: ctx.accounts.user_mint_acc.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    pool.staked_total = pool.staked_total.safe_add(amount)?;
    ctx.accounts.user_state.staked_amount =
        ctx.accounts.user_state.staked_amount.safe_add(amount)?;

    Ok(())
}

fn handle_leave_staking(ctx: Context<LeaveStaking>, amount: u64) -> PoolResult {
    let pool = &mut ctx.accounts.pool.load_mut()?;

    require!(amount > 0, PoolError::ZeroAmount);
    require_eq!(pool.mint, ctx.accounts.mint.key(), PoolError::InvalidMint);
    require_eq!(
        pool.vault,
        ctx.accounts.vault.key(),
        PoolError::InvalidVault
    );

    require!(
        ctx.accounts.user_state.initialized,
        PoolError::UserNotInitialized
    );

    let seeds = &[
        ctx.accounts.mint.key.as_ref(),
        ctx.accounts.pool.to_account_info().key.as_ref(),
        &[pool.nonce],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.user_mint_acc.to_account_info(),
        authority: ctx.accounts.program_signer.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token::transfer(cpi_ctx, amount)?;

    pool.staked_total = pool.staked_total.safe_sub(amount)?;
    ctx.accounts.user_state.staked_amount =
        ctx.accounts.user_state.staked_amount.safe_sub(amount)?;

    Ok(())
}

#[program]
pub mod staking_pool {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, nonce: u8) -> PoolResult {
        handle_initialize(ctx, nonce)
    }

    pub fn airdrop(ctx: Context<AirDrop>, amount: u64) -> PoolResult {
        handle_airdrop(ctx, amount)
    }

    pub fn initialize_user_state(ctx: Context<InitializeUserState>) -> PoolResult {
        handle_initialize_user_state(ctx)
    }

    pub fn enter_staking(ctx: Context<EnterStaking>, amount: u64) -> PoolResult {
        handle_enter_staking(ctx, amount)
    }

    pub fn leave_staking(ctx: Context<LeaveStaking>, amount: u64) -> PoolResult {
        handle_leave_staking(ctx, amount)
    }
}
