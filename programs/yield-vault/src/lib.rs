use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{
    self, CloseAccount, Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount,
    TokenInterface, TransferChecked,
};

declare_id!("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5");

const MAX_ALLOWED_PROGRAMS: usize = 64;
/// Allocation routes, indexed into `Vault::allocation_bps`. Unused indices are reserved for future protocols.
pub const MAX_ROUTES: usize = 8;
pub const ROUTE_KAMINO_USDC: usize = 0;
pub const ROUTE_ONYC: usize = 1;
const BPS_DENOMINATOR: u32 = 10_000;

fn validate_allocation(allocation_bps: &[u16; MAX_ROUTES]) -> Result<()> {
    let total: u32 = allocation_bps.iter().map(|bps| u32::from(*bps)).sum();
    require!(total <= BPS_DENOMINATOR, ErrorCode::AllocationTooHigh);
    Ok(())
}

#[program]
pub mod yield_vault {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        agent: Pubkey,
        allocation_bps: [u16; MAX_ROUTES],
        allowed_programs: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            allowed_programs.len() <= MAX_ALLOWED_PROGRAMS,
            ErrorCode::TooManyPrograms
        );
        validate_allocation(&allocation_bps)?;
        let vault = &mut ctx.accounts.vault;
        vault.bump = ctx.bumps.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.agent = agent;
        vault.allocation_bps = allocation_bps;
        vault.last_rebalance_ts = Clock::get()?.unix_timestamp;
        vault.allowed_programs = allowed_programs;
        Ok(())
    }

    /// Sponsored creation: any payer creates the Safe for `owner` without the owner's signature, so a
    /// user arriving via CCTP needs no SOL. Only safe defaults are allowed (no agent, no CPI allowlist,
    /// zero allocation); the owner configures the rest. `close_safe` returns the rent to the owner.
    pub fn create_safe_for(ctx: Context<CreateSafeFor>, owner: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.bump = ctx.bumps.vault;
        vault.owner = owner;
        vault.agent = Pubkey::default();
        vault.allocation_bps = [0; MAX_ROUTES];
        vault.last_rebalance_ts = Clock::get()?.unix_timestamp;
        vault.allowed_programs = Vec::new();
        Ok(())
    }

    /// Owner sets target allocation per route in basis points (sum <= 10_000, the rest stays idle USDC).
    /// Future agent instructions must respect these targets.
    pub fn set_allocation(ctx: Context<SetAllocation>, allocation_bps: [u16; MAX_ROUTES]) -> Result<()> {
        validate_allocation(&allocation_bps)?;
        ctx.accounts.vault.allocation_bps = allocation_bps;
        Ok(())
    }

    pub fn set_allowed_programs(
        ctx: Context<SetAllowedPrograms>,
        allowed_programs: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            allowed_programs.len() <= MAX_ALLOWED_PROGRAMS,
            ErrorCode::TooManyPrograms
        );
        let vault = &mut ctx.accounts.vault;
        vault.allowed_programs = allowed_programs;
        Ok(())
    }

    /// The owner may rotate or revoke the agent. Pubkey::default() revokes it.
    /// Agent execution remains disabled for generic CPI instructions in v2.
    pub fn set_agent(ctx: Context<SetAgent>, agent: Pubkey) -> Result<()> {
        ctx.accounts.vault.agent = agent;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_usdc_ata.to_account_info(),
                    to: ctx.accounts.vault_usdc_ata.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Owner deposits any SPL Token or Token-2022 mint into a vault-owned ATA.
    /// This is the generic asset ingress path for assets such as cbBTC and xStocks.
    pub fn deposit_spl<'info>(
        ctx: Context<'_, '_, '_, 'info, DepositSpl<'info>>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.owner_token_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault_token_ata.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }

    /// Owner pulls USDC from the vault ATA. Authority on the vault token account is the vault PDA (`invoke_signed`).
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        let vault = &ctx.accounts.vault;
        let owner_key = ctx.accounts.owner.key();
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[vault.bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_usdc_ata.to_account_info(),
                    to: ctx.accounts.owner_usdc_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        Ok(())
    }

    /// Owner pulls **any** SPL mint from a vault-owned token account into the owner's ATA for that mint.
    /// The vault must already hold a token account for `mint` (e.g. created by a prior swap or `createAssociatedTokenAccount`).
    /// For the mint used at `initialize`, `withdraw` is equivalent but uses ATA constraints; this instruction accepts any
    /// vault token account whose authority is the vault PDA.
    pub fn withdraw_spl<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawSpl<'info>>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        let vault = &ctx.accounts.vault;
        let owner_key = ctx.accounts.owner.key();
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[vault.bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_token_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer,
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }

    /// Owner-only CPI into a whitelisted program. Pass remaining accounts as:
    /// `[program_id_account, ...accounts matching Instruction.accounts order for that program]`.
    /// The vault PDA may sign as authority via seeds `[b"vault", owner.key(), bump]`.
    pub fn execute_swap_cpi(ctx: Context<ExecuteSwap>, data: Vec<u8>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require_keys_eq!(ctx.accounts.authority.key(), vault.owner, ErrorCode::Unauthorized);
        let rem = ctx.remaining_accounts;
        require!(!rem.is_empty(), ErrorCode::MissingCpiProgram);
        let program_id = rem[0].key();
        require!(
            vault.allowed_programs.iter().any(|p| *p == program_id),
            ErrorCode::ProgramNotWhitelisted
        );
        let vault_key = vault.key();
        let account_metas: Vec<AccountMeta> = rem[1..]
            .iter()
            .map(|a| {
                // Outer tx cannot include a PDA signature; the inner protocol ix may still
                // expect the vault PDA as a signer. `invoke_signed` authorizes it via seeds.
                let is_signer = a.key() == vault_key || a.is_signer;
                if a.is_writable {
                    AccountMeta::new(a.key(), is_signer)
                } else {
                    AccountMeta::new_readonly(a.key(), is_signer)
                }
            })
            .collect();
        let ix = Instruction {
            program_id,
            accounts: account_metas,
            data,
        };
        let seeds: &[&[u8]] = &[b"vault", vault.owner.as_ref(), &[vault.bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        invoke_signed(&ix, rem, signer)?;
        vault.last_rebalance_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Owner-only generic CPI gateway into a whitelisted protocol program. Pass remaining accounts as:
    /// `[program_id_account, ...accounts matching Instruction.accounts order for that program]`.
    /// The vault PDA may sign as authority via seeds `[b"vault", owner.key(), bump]`.
    pub fn execute_protocol_cpi(ctx: Context<ExecuteProtocol>, data: Vec<u8>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require_keys_eq!(ctx.accounts.authority.key(), vault.owner, ErrorCode::Unauthorized);
        let rem = ctx.remaining_accounts;
        require!(!rem.is_empty(), ErrorCode::MissingCpiProgram);
        let program_id = rem[0].key();
        require!(
            vault.allowed_programs.iter().any(|p| *p == program_id),
            ErrorCode::ProgramNotWhitelisted
        );
        let vault_key = vault.key();
        let account_metas: Vec<AccountMeta> = rem[1..]
            .iter()
            .map(|a| {
                // Outer tx cannot include a PDA signature; the inner protocol ix may still
                // expect the vault PDA as a signer. `invoke_signed` authorizes it via seeds.
                let is_signer = a.key() == vault_key || a.is_signer;
                if a.is_writable {
                    AccountMeta::new(a.key(), is_signer)
                } else {
                    AccountMeta::new_readonly(a.key(), is_signer)
                }
            })
            .collect();
        let ix = Instruction {
            program_id,
            accounts: account_metas,
            data,
        };
        let seeds: &[&[u8]] = &[b"vault", vault.owner.as_ref(), &[vault.bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        invoke_signed(&ix, rem, signer)?;
        vault.last_rebalance_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Owner-only: close a zero-balance SPL Token / Token-2022 account owned by the Safe PDA.
    /// Rent always goes to the owner.
    pub fn close_empty_token_account(ctx: Context<CloseEmptyTokenAccount>) -> Result<()> {
        require!(ctx.accounts.token_account.amount == 0, ErrorCode::TokenAccountNotEmpty);
        let vault = &ctx.accounts.vault;
        let owner_key = ctx.accounts.owner.key();
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[vault.bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.token_account.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer,
        ))
    }

    /// Owner-only: move Safe PDA lamports above its rent-exempt minimum to the owner.
    pub fn withdraw_excess_lamports(ctx: Context<WithdrawExcessLamports>) -> Result<()> {
        let vault_info = ctx.accounts.vault.to_account_info();
        let minimum = Rent::get()?.minimum_balance(vault_info.data_len());
        let excess = vault_info.lamports().saturating_sub(minimum);
        require!(excess > 0, ErrorCode::NoExcessLamports);
        // The Safe PDA is owned by this program, so it can be debited directly.
        vault_info.sub_lamports(excess)?;
        ctx.accounts.owner.to_account_info().add_lamports(excess)?;
        Ok(())
    }

    /// Owner-only: close the Safe account and return all its lamports to the owner.
    /// Token accounts cannot be enumerated on-chain; the client must close or empty them first.
    /// Anything left behind stays recoverable: the PDA is derived from the owner, and
    /// `initialize` accepts an existing USDC ATA, so re-initializing restores control.
    pub fn close_safe(_ctx: Context<CloseSafe>) -> Result<()> {
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
    pub owner: Pubkey,
    pub agent: Pubkey,
    /// Owner's target allocation in basis points, indexed by ROUTE_* constants.
    pub allocation_bps: [u16; MAX_ROUTES],
    pub last_rebalance_ts: i64,
    #[max_len(64)]
    pub allowed_programs: Vec<Pubkey>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    // init_if_needed: after close_safe the ATA may still exist; re-initializing must reuse it.
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
    )]
    pub vault_usdc_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct CreateSafeFor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
    )]
    pub vault_usdc_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAllocation<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct SetAllowedPrograms<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
        realloc = 8 + Vault::INIT_SPACE,
        realloc::payer = owner,
        realloc::zero = false,
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAgent<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = owner,
    )]
    pub owner_usdc_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
    )]
    pub vault_usdc_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DepositSpl<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
    pub mint: InterfaceAccount<'info, InterfaceMint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_token_ata: InterfaceAccount<'info, InterfaceTokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token_ata: InterfaceAccount<'info, InterfaceTokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = owner,
    )]
    pub owner_usdc_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
    )]
    pub vault_usdc_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawSpl<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
    pub mint: InterfaceAccount<'info, InterfaceMint>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_token_ata: InterfaceAccount<'info, InterfaceTokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token_ata: InterfaceAccount<'info, InterfaceTokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct ExecuteProtocol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct CloseEmptyTokenAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, InterfaceTokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawExcessLamports<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct CloseSafe<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("CPI program account missing")]
    MissingCpiProgram,
    #[msg("Program not in vault whitelist")]
    ProgramNotWhitelisted,
    #[msg("Too many programs in whitelist")]
    TooManyPrograms,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Token account still holds tokens")]
    TokenAccountNotEmpty,
    #[msg("Safe holds no lamports above its rent-exempt minimum")]
    NoExcessLamports,
    #[msg("Allocation exceeds 100% (10_000 bps)")]
    AllocationTooHigh,
}
