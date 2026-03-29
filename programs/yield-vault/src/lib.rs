use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s");

#[program]
pub mod yield_vault {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        agent: Pubkey,
        strategy: Strategy,
        allowed_programs: Vec<Pubkey>,
    ) -> Result<()> {
        require!(allowed_programs.len() <= 16, ErrorCode::TooManyPrograms);
        let vault = &mut ctx.accounts.vault;
        vault.bump = ctx.bumps.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.agent = agent;
        vault.strategy = strategy;
        vault.last_rebalance_ts = Clock::get()?.unix_timestamp;
        vault.allowed_programs = allowed_programs;
        Ok(())
    }

    pub fn set_allowed_programs(
        ctx: Context<SetAllowedPrograms>,
        allowed_programs: Vec<Pubkey>,
    ) -> Result<()> {
        require!(allowed_programs.len() <= 16, ErrorCode::TooManyPrograms);
        let vault = &mut ctx.accounts.vault;
        vault.allowed_programs = allowed_programs;
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


    /// CPI into a whitelisted program. Pass remaining accounts as:
    /// `[program_id_account, ...accounts matching Instruction.accounts order for that program]`.
    /// The vault PDA may sign as authority via seeds `[b"vault", owner.key(), bump]`.
    pub fn execute_swap_cpi(ctx: Context<ExecuteSwap>, data: Vec<u8>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.authority.key() == vault.agent
                || ctx.accounts.authority.key() == vault.owner,
            ErrorCode::Unauthorized
        );
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
                // Outer tx cannot include a PDA signature; Jupiter still expects the taker PDA as a
                // signer on the inner ix. `invoke_signed` authorizes the vault PDA via seeds.
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
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum Strategy {
    Conservative,
    Balanced,
    Growth,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub strategy: Strategy,
    pub last_rebalance_ts: i64,
    #[max_len(16)]
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
    #[account(
        init,
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
pub struct SetAllowedPrograms<'info> {
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
}
