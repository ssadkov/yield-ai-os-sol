use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{
    self, CloseAccount, Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount,
    TokenInterface, TransferChecked,
};

declare_id!("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5");

/// Owner CPI allowlist size. 16 keeps Safe rent low (the list is reserved in full at creation).
const MAX_ALLOWED_PROGRAMS: usize = 16;
/// Allocation routes, indexed into `Vault::allocation_bps`. Unused indices are reserved for future protocols.
pub const MAX_ROUTES: usize = 8;
pub const ROUTE_KAMINO_USDC: usize = 0;
pub const ROUTE_ONYC: usize = 1;
const BPS_DENOMINATOR: u32 = 10_000;
/// Hard cap on the protocol performance fee, whatever the admin configures.
pub const MAX_PERFORMANCE_FEE_BPS: u16 = 2_000;

/// Split a route exit into the principal it returns and the protocol fee on the gain.
/// `principal` is the owner's tracked cost basis for the route, `shares_out` of `shares_before`
/// are redeemed and `received` USDC came back. Losses pay no fee.
pub fn realize_exit(principal: u64, shares_out: u64, shares_before: u64, received: u64, fee_bps: u16) -> (u64, u64) {
    let principal_out = if shares_before == 0 || shares_out >= shares_before {
        principal
    } else {
        (u128::from(principal) * u128::from(shares_out) / u128::from(shares_before)) as u64
    };
    let gain = received.saturating_sub(principal_out);
    let fee = (u128::from(gain) * u128::from(fee_bps) / u128::from(BPS_DENOMINATOR)) as u64;
    (principal_out, fee)
}

/// Kamino kVault program and the only kVault the agent may use (Kamino USDC, mainnet).
const KAMINO_KVAULT_PROGRAM: Pubkey = pubkey!("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
const KAMINO_USDC_KVAULT: Pubkey = pubkey!("91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy");
/// Shares of that kVault. They may only enter or leave the Safe through kamino_deposit/withdraw,
/// otherwise the cost basis (and the fee on gains) could be bypassed or inflated.
const KAMINO_USDC_KVAULT_SHARES: Pubkey = pubkey!("B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe");
/// Anchor discriminators of the kVault instructions (sha256("global:<name>")[..8]).
const KVAULT_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const KVAULT_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
const KVAULT_WITHDRAW_FROM_AVAILABLE: [u8; 8] = [19, 131, 112, 155, 170, 220, 34, 57];
/// Account positions inside the kVault instruction (after the program account in remaining_accounts).
const KV_USER: usize = 0;
const KV_VAULT_STATE: usize = 1;
const KV_DEPOSIT_USER_TOKEN_ATA: usize = 6;
const KV_DEPOSIT_USER_SHARES_ATA: usize = 7;
const KV_DEPOSIT_FIXED_ACCOUNTS: usize = 13;
const KV_WITHDRAW_USER_TOKEN_ATA: usize = 5;
const KV_WITHDRAW_USER_SHARES_ATA: usize = 7;
const KV_WITHDRAW_AVAILABLE_FIXED_ACCOUNTS: usize = 14;
const KV_WITHDRAW_FULL_FIXED_ACCOUNTS: usize = 25;

fn validate_allocation(allocation_bps: &[u16; MAX_ROUTES]) -> Result<()> {
    let total: u32 = allocation_bps.iter().map(|bps| u32::from(*bps)).sum();
    require!(total <= BPS_DENOMINATOR, ErrorCode::AllocationTooHigh);
    Ok(())
}

/// Upgrade authority stored in this program's ProgramData account. Parsed by hand instead of
/// `Account<ProgramData>`, which pulls in bincode and adds ~100 KB to the binary.
/// Layout: u32 enum tag (3 = ProgramData) | u64 slot | u8 Option tag | [u8; 32] authority.
fn upgrade_authority(program_data: &AccountInfo) -> Result<Option<Pubkey>> {
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, ErrorCode::Unauthorized);
    let data = program_data.try_borrow_data()?;
    require!(data.len() >= 45 && data[0..4] == [3, 0, 0, 0], ErrorCode::Unauthorized);
    Ok(match data[12] {
        1 => Some(Pubkey::new_from_array(data[13..45].try_into().unwrap())),
        _ => None,
    })
}

/// The Safe's canonical shares account for the Kamino USDC kVault. kVault shares must live here so
/// that no other instruction can move them past the fee accounting.
fn kamino_shares_ata(safe: &Pubkey) -> Pubkey {
    anchor_spl::associated_token::get_associated_token_address(safe, &KAMINO_USDC_KVAULT_SHARES)
}

/// Owner, or the configured agent (the default key means "no agent").
fn require_owner_or_agent(vault: &Vault, authority: &Pubkey) -> Result<()> {
    let is_agent = vault.agent != Pubkey::default() && *authority == vault.agent;
    require!(*authority == vault.owner || is_agent, ErrorCode::Unauthorized);
    Ok(())
}

/// The account must be an SPL Token / Token-2022 account whose authority is the Safe PDA.
/// Returns its balance. This is what keeps agent actions inside the Safe.
fn safe_token_balance(info: &AccountInfo, safe: &Pubkey) -> Result<u64> {
    require!(
        *info.owner == anchor_spl::token::ID || *info.owner == anchor_spl::token_2022::ID,
        ErrorCode::NotSafeTokenAccount
    );
    let data = info.try_borrow_data()?;
    let account = InterfaceTokenAccount::try_deserialize(&mut &data[..])
        .map_err(|_| error!(ErrorCode::NotSafeTokenAccount))?;
    require_keys_eq!(account.owner, *safe, ErrorCode::NotSafeTokenAccount);
    Ok(account.amount)
}

/// Checks shared by every kVault call, then invokes it with the Safe PDA as signer.
/// `rem` = [kVault program, ...kVault instruction accounts in IDL order, ...remaining accounts].
fn invoke_kvault(
    vault: &Account<Vault>,
    rem: &[AccountInfo],
    data: Vec<u8>,
    fixed_accounts: usize,
    user_token_ata: usize,
    user_shares_ata: usize,
) -> Result<()> {
    require!(rem.len() > fixed_accounts, ErrorCode::InvalidKaminoAccounts);
    require_keys_eq!(rem[0].key(), KAMINO_KVAULT_PROGRAM, ErrorCode::InvalidKaminoAccounts);
    let inner = &rem[1..];
    let vault_key = vault.key();
    require_keys_eq!(inner[KV_USER].key(), vault_key, ErrorCode::InvalidKaminoAccounts);
    require_keys_eq!(inner[KV_VAULT_STATE].key(), KAMINO_USDC_KVAULT, ErrorCode::KaminoVaultNotAllowed);
    safe_token_balance(&inner[user_token_ata], &vault_key)?;
    safe_token_balance(&inner[user_shares_ata], &vault_key)?;
    require_keys_eq!(inner[user_shares_ata].key(), kamino_shares_ata(&vault_key), ErrorCode::InvalidKaminoAccounts);

    let metas: Vec<AccountMeta> = inner
        .iter()
        .map(|a| {
            let is_signer = a.key() == vault_key || a.is_signer;
            if a.is_writable {
                AccountMeta::new(a.key(), is_signer)
            } else {
                AccountMeta::new_readonly(a.key(), is_signer)
            }
        })
        .collect();
    let ix = Instruction { program_id: KAMINO_KVAULT_PROGRAM, accounts: metas, data };
    let seeds: &[&[u8]] = &[b"vault", vault.owner.as_ref(), &[vault.bump]];
    invoke_signed(&ix, rem, &[seeds])?;
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

    /// One-time protocol config. Only the program's upgrade authority can create it, so nobody can
    /// front-run the deploy and become admin.
    pub fn init_config(ctx: Context<InitConfig>, treasury: Pubkey, performance_fee_bps: u16) -> Result<()> {
        require!(performance_fee_bps <= MAX_PERFORMANCE_FEE_BPS, ErrorCode::FeeTooHigh);
        require!(
            upgrade_authority(&ctx.accounts.program_data)? == Some(ctx.accounts.admin.key()),
            ErrorCode::Unauthorized
        );
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = treasury;
        config.performance_fee_bps = performance_fee_bps;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin updates the treasury, the fee (capped) or hands admin over (e.g. to a Squads vault).
    pub fn set_config(ctx: Context<SetConfig>, admin: Pubkey, treasury: Pubkey, performance_fee_bps: u16) -> Result<()> {
        require!(performance_fee_bps <= MAX_PERFORMANCE_FEE_BPS, ErrorCode::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.treasury = treasury;
        config.performance_fee_bps = performance_fee_bps;
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
        require_keys_neq!(ctx.accounts.usdc_mint.key(), KAMINO_USDC_KVAULT_SHARES, ErrorCode::UseDedicatedInstruction);
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
        require_keys_neq!(ctx.accounts.mint.key(), KAMINO_USDC_KVAULT_SHARES, ErrorCode::UseDedicatedInstruction);
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
        require_keys_neq!(ctx.accounts.usdc_mint.key(), KAMINO_USDC_KVAULT_SHARES, ErrorCode::UseDedicatedInstruction);
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
        require_keys_neq!(ctx.accounts.mint.key(), KAMINO_USDC_KVAULT_SHARES, ErrorCode::UseDedicatedInstruction);
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
        // Routes with fee and principal accounting must go through their dedicated instructions.
        require!(program_id != KAMINO_KVAULT_PROGRAM, ErrorCode::UseDedicatedInstruction);
        let vault_key = vault.key();
        let shares_ata = kamino_shares_ata(&vault_key);
        require!(!rem.iter().any(|a| a.key() == shares_ata), ErrorCode::UseDedicatedInstruction);
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
        // Routes with fee and principal accounting must go through their dedicated instructions.
        require!(program_id != KAMINO_KVAULT_PROGRAM, ErrorCode::UseDedicatedInstruction);
        let vault_key = vault.key();
        let shares_ata = kamino_shares_ata(&vault_key);
        require!(!rem.iter().any(|a| a.key() == shares_ata), ErrorCode::UseDedicatedInstruction);
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

    /// Owner or agent: move `amount` USDC from the Safe into the Kamino USDC kVault.
    /// Funds can only travel between the Safe's own token accounts and that kVault, and a single
    /// deposit may not exceed the owner's Kamino target share of the Safe's idle USDC.
    pub fn kamino_deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, KaminoAction<'info>>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        let vault = &ctx.accounts.vault;
        require_owner_or_agent(vault, &ctx.accounts.authority.key())?;
        let target_bps = vault.allocation_bps[ROUTE_KAMINO_USDC];
        require!(target_bps > 0, ErrorCode::RouteDisabled);

        let rem = ctx.remaining_accounts;
        require!(rem.len() > KV_DEPOSIT_FIXED_ACCOUNTS, ErrorCode::InvalidKaminoAccounts);
        let idle = safe_token_balance(&rem[1 + KV_DEPOSIT_USER_TOKEN_ATA], &vault.key())?;
        let cap = (u128::from(idle) * u128::from(target_bps) / u128::from(BPS_DENOMINATOR)) as u64;
        require!(amount <= cap, ErrorCode::AllocationExceeded);

        let mut data = KVAULT_DEPOSIT.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        invoke_kvault(vault, rem, data, KV_DEPOSIT_FIXED_ACCOUNTS,
            KV_DEPOSIT_USER_TOKEN_ATA, KV_DEPOSIT_USER_SHARES_ATA)?;
        // Cost basis = what actually left the Safe, not the requested amount.
        let idle_after = safe_token_balance(&rem[1 + KV_DEPOSIT_USER_TOKEN_ATA], &ctx.accounts.vault.key())?;
        let deposited = idle.saturating_sub(idle_after);
        let vault = &mut ctx.accounts.vault;
        vault.route_principal[ROUTE_KAMINO_USDC] = vault.route_principal[ROUTE_KAMINO_USDC].saturating_add(deposited);
        vault.last_rebalance_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Owner or agent: redeem `shares` from the Kamino USDC kVault back into the Safe.
    /// `from_reserve = false` uses withdraw_from_available; `true` uses the full withdraw that may
    /// pull liquidity from a lending reserve. USDC always lands in the Safe's own token account.
    pub fn kamino_withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, KaminoWithdraw<'info>>,
        shares: u64,
        from_reserve: bool,
    ) -> Result<()> {
        require!(shares > 0, ErrorCode::ZeroAmount);
        let vault_key = ctx.accounts.vault.key();
        require_owner_or_agent(&ctx.accounts.vault, &ctx.accounts.authority.key())?;
        let (discriminator, fixed) = if from_reserve {
            (KVAULT_WITHDRAW, KV_WITHDRAW_FULL_FIXED_ACCOUNTS)
        } else {
            (KVAULT_WITHDRAW_FROM_AVAILABLE, KV_WITHDRAW_AVAILABLE_FIXED_ACCOUNTS)
        };
        let rem = ctx.remaining_accounts;
        require!(rem.len() > fixed, ErrorCode::InvalidKaminoAccounts);
        let safe_usdc = &rem[1 + KV_WITHDRAW_USER_TOKEN_ATA];
        let shares_before = safe_token_balance(&rem[1 + KV_WITHDRAW_USER_SHARES_ATA], &vault_key)?;
        // Kamino uses u64::MAX as "redeem all" on the final reserve leg.
        require!(shares == u64::MAX || shares <= shares_before, ErrorCode::InsufficientShares);
        let usdc_before = safe_token_balance(safe_usdc, &vault_key)?;

        let mut data = discriminator.to_vec();
        data.extend_from_slice(&shares.to_le_bytes());
        invoke_kvault(&ctx.accounts.vault, rem, data, fixed,
            KV_WITHDRAW_USER_TOKEN_ATA, KV_WITHDRAW_USER_SHARES_ATA)?;

        let shares_after = safe_token_balance(&rem[1 + KV_WITHDRAW_USER_SHARES_ATA], &vault_key)?;
        let burned = shares_before.checked_sub(shares_after).ok_or(ErrorCode::InsufficientShares)?;
        require!(burned > 0 && (shares == u64::MAX || burned == shares), ErrorCode::InsufficientShares);
        let received = safe_token_balance(safe_usdc, &vault_key)?.saturating_sub(usdc_before);
        let principal = ctx.accounts.vault.route_principal[ROUTE_KAMINO_USDC];
        let (principal_out, fee) = realize_exit(principal, burned, shares_before, received,
            ctx.accounts.config.performance_fee_bps);

        if fee > 0 {
            // Fee goes only to the configured treasury's USDC account, signed by the Safe PDA.
            require_keys_eq!(*safe_usdc.owner, anchor_spl::token::ID, ErrorCode::NotSafeTokenAccount);
            let usdc_mint = {
                let data = safe_usdc.try_borrow_data()?;
                InterfaceTokenAccount::try_deserialize(&mut &data[..])?.mint
            };
            let treasury = &ctx.accounts.treasury_usdc_ata;
            require_keys_eq!(treasury.owner, ctx.accounts.config.treasury, ErrorCode::InvalidTreasury);
            require_keys_eq!(treasury.mint, usdc_mint, ErrorCode::InvalidTreasury);
            let owner_key = ctx.accounts.vault.owner;
            let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[ctx.accounts.vault.bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: safe_usdc.clone(),
                        to: treasury.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
            )?;
        }
        let vault = &mut ctx.accounts.vault;
        vault.route_principal[ROUTE_KAMINO_USDC] = principal.saturating_sub(principal_out);
        vault.last_rebalance_ts = Clock::get()?.unix_timestamp;
        emit!(RouteExit { vault: vault_key, route: ROUTE_KAMINO_USDC as u8, received, principal_out, fee });
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
    #[max_len(16)]
    pub allowed_programs: Vec<Pubkey>,
    /// Owner's cost basis per route (USDC base units), used to charge fees only on gains.
    /// Appended last so earlier field offsets stay stable.
    pub route_principal: [u64; MAX_ROUTES],
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Wallet whose USDC token account receives performance fees.
    pub treasury: Pubkey,
    pub performance_fee_bps: u16,
    pub bump: u8,
}

#[event]
pub struct RouteExit {
    pub vault: Pubkey,
    pub route: u8,
    pub received: u64,
    pub principal_out: u64,
    pub fee: u64,
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
pub struct KaminoAction<'info> {
    /// Owner or agent; checked in the handler.
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct KaminoWithdraw<'info> {
    /// Owner or agent; checked in the handler.
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// Treasury USDC account; owner and mint are checked in the handler when a fee is due.
    #[account(mut)]
    pub treasury_usdc_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    /// CHECK: this program's ProgramData (address fixed by seeds); the handler requires its
    /// upgrade authority to be the signing admin.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
    )]
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
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
    #[msg("Kamino accounts do not match the expected kVault instruction layout")]
    InvalidKaminoAccounts,
    #[msg("Only the Kamino USDC kVault is allowed")]
    KaminoVaultNotAllowed,
    #[msg("Token account is not owned by this Safe")]
    NotSafeTokenAccount,
    #[msg("Owner allocation for this route is zero")]
    RouteDisabled,
    #[msg("Amount exceeds the owner's allocation for this route")]
    AllocationExceeded,
    #[msg("Performance fee above the hard cap")]
    FeeTooHigh,
    #[msg("Treasury token account does not match the config")]
    InvalidTreasury,
    #[msg("Not enough shares in the Safe")]
    InsufficientShares,
    #[msg("This protocol must be used through its dedicated instruction")]
    UseDedicatedInstruction,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_exit_with_gain_pays_fee_on_gain_only() {
        // 60 USDC in, 63 USDC out, 5% fee -> 0.15 USDC fee, all principal returned.
        assert_eq!(realize_exit(60_000_000, 500, 500, 63_000_000, 500), (60_000_000, 150_000));
    }

    #[test]
    fn loss_pays_no_fee() {
        assert_eq!(realize_exit(60_000_000, 500, 500, 59_998_995, 500), (60_000_000, 0));
    }

    #[test]
    fn partial_exit_uses_proportional_principal() {
        // Redeem a quarter of the shares: principal out 15; received 16 -> gain 1 -> fee 0.05 at 5%.
        assert_eq!(realize_exit(60_000_000, 25, 100, 16_000_000, 500), (15_000_000, 50_000));
    }

    #[test]
    fn untracked_principal_counts_everything_as_gain() {
        // Positions opened outside kamino_deposit have no cost basis; generic CPI to kVault is blocked.
        assert_eq!(realize_exit(0, 10, 10, 1_000_000, 500), (0, 50_000));
    }

    #[test]
    fn zero_fee_config() {
        assert_eq!(realize_exit(1, 1, 1, 2, 0), (1, 0));
    }
}
