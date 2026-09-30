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

declare_id!("yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih");

mod exponent;
mod exponent_accounts;
pub use exponent::*;

/// Owner CPI allowlist size. 16 keeps Safe rent low (the list is reserved in full at creation).
const MAX_ALLOWED_PROGRAMS: usize = 16;
/// Admin-managed executor keys. The separate PDA avoids changing the deployed Config account size.
const MAX_EXECUTORS: usize = 16;
/// Allocation routes, indexed into `Vault::allocation_bps`. Unused indices are reserved for future protocols.
pub const MAX_ROUTES: usize = 8;
pub const ROUTE_KAMINO_USDC: usize = 0;
pub const ROUTE_ONYC: usize = 1;
const BPS_DENOMINATOR: u32 = 10_000;
// Current hour plus 24 previous hours: an action near an hour boundary is never dropped early.
const EXECUTOR_VOLUME_HOURS: usize = 25;
const SECONDS_PER_HOUR: i64 = 3_600;
const DEFAULT_EXECUTOR_LIMIT_USDC: u64 = 1_000_000_000; // 1,000 USDC (six decimals)
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

fn validate_executors(default_executor: Pubkey, approved: &[Pubkey]) -> Result<()> {
    require!(approved.len() <= MAX_EXECUTORS, ErrorCode::TooManyExecutors);
    for (index, executor) in approved.iter().enumerate() {
        require!(*executor != Pubkey::default(), ErrorCode::InvalidExecutor);
        require!(!approved[..index].contains(executor), ErrorCode::DuplicateExecutor);
    }
    require!(
        default_executor == Pubkey::default() || approved.contains(&default_executor),
        ErrorCode::ExecutorNotApproved
    );
    Ok(())
}

/// The owner always retains control. An agent must match this Safe and the current admin whitelist.
fn require_owner_or_agent(vault: &Vault, authority: &Pubkey, registry: &ExecutorRegistry) -> Result<()> {
    if *authority == vault.owner {
        return Ok(());
    }
    require!(vault.agent != Pubkey::default() && *authority == vault.agent, ErrorCode::Unauthorized);
    require!(registry.approved.contains(authority), ErrorCode::ExecutorNotApproved);
    Ok(())
}

/// Keep the original Kamino instruction account list stable. An executor appends the
/// policy PDA after the Kamino accounts; owner-signed legacy transactions append nothing.
fn executor_policy_from_tail(
    vault: &Account<Vault>, policy_info: &AccountInfo,
) -> Result<ExecutorLimits> {
    let (expected, _) = Pubkey::find_program_address(
        &[b"executor_limits", vault.key().as_ref()], &crate::ID);
    require_keys_eq!(policy_info.key(), expected, ErrorCode::InvalidExecutorLimits);
    require_keys_eq!(*policy_info.owner, crate::ID, ErrorCode::InvalidExecutorLimits);
    require!(policy_info.is_writable, ErrorCode::InvalidExecutorLimits);
    let data = policy_info.try_borrow_data()?;
    let limits = ExecutorLimits::try_deserialize(&mut &data[..])
        .map_err(|_| error!(ErrorCode::ExecutorLimitsMissing))?;
    require_keys_eq!(limits.vault, vault.key(), ErrorCode::InvalidExecutorLimits);
    require!(limits.enabled, ErrorCode::ExecutorPaused);
    Ok(limits)
}

fn save_executor_policy(policy_info: &AccountInfo, limits: &ExecutorLimits) -> Result<()> {
    let mut data = policy_info.try_borrow_mut_data()?;
    limits.try_serialize(&mut &mut data[..])?;
    Ok(())
}

/// Charge every executor-controlled USDC movement to a conservative rolling 24-hour budget.
/// Whole hourly buckets can make the window up to one hour longer, never shorter.
fn charge_executor_volume(
    vault: &Account<Vault>,
    authority: &Pubkey,
    limits: Option<&mut ExecutorLimits>,
    moved_usdc: u64,
    principal_after_deposit: Option<u128>,
    now: i64,
) -> Result<()> {
    if *authority == vault.owner { return Ok(()); }
    let limits = limits.ok_or(ErrorCode::ExecutorLimitsMissing)?;
    require_keys_eq!(limits.vault, vault.key(), ErrorCode::InvalidExecutorLimits);
    charge_volume(limits, moved_usdc, principal_after_deposit, now)
}

fn charge_volume(
    limits: &mut ExecutorLimits,
    moved_usdc: u64,
    principal_after_deposit: Option<u128>,
    now: i64,
) -> Result<()> {
    require!(limits.enabled, ErrorCode::ExecutorPaused);
    require!(moved_usdc > 0 && moved_usdc <= limits.max_action_usdc, ErrorCode::ExecutorActionLimit);
    if let Some(principal) = principal_after_deposit {
        require!(principal <= u128::from(limits.max_principal_usdc), ErrorCode::ExecutorPositionLimit);
    }
    let hour = now.div_euclid(SECONDS_PER_HOUR);
    let index = hour.rem_euclid(EXECUTOR_VOLUME_HOURS as i64) as usize;
    if limits.hour_epoch[index] != hour {
        limits.hour_epoch[index] = hour;
        limits.hour_volume[index] = 0;
    }
    let previous: u128 = (0..EXECUTOR_VOLUME_HOURS)
        .filter(|&i| limits.hour_epoch[i] >= hour - (EXECUTOR_VOLUME_HOURS as i64 - 1)
            && limits.hour_epoch[i] <= hour)
        .map(|i| u128::from(limits.hour_volume[i]))
        .sum();
    require!(previous + u128::from(moved_usdc) <= u128::from(limits.max_24h_volume_usdc),
        ErrorCode::ExecutorVolumeLimit);
    limits.hour_volume[index] = limits.hour_volume[index]
        .checked_add(moved_usdc).ok_or(ErrorCode::ExecutorVolumeLimit)?;
    Ok(())
}

/// Cost-basis target: repeated deposits cannot turn a 50% owner target into nearly 100%.
/// This is conservative accounting in USDC base units, not a live Kamino NAV oracle.
fn total_principal_after(vault: &Vault, route: usize, principal_after: u64) -> u128 {
    vault.route_principal.iter().enumerate()
        .map(|(index, amount)| u128::from(if index == route { principal_after } else { *amount }))
        .sum()
}

fn principal_within_target(vault: &Vault, route: usize, principal_after: u64, idle_after: u64) -> bool {
    let total_principal = total_principal_after(vault, route, principal_after);
    let total_basis = total_principal + u128::from(idle_after);
    u128::from(principal_after) * u128::from(BPS_DENOMINATOR)
        <= total_basis * u128::from(vault.allocation_bps[route])
}

fn initialize_vault_state(
    vault: &mut Account<Vault>, bump: u8, owner: Pubkey, agent: Pubkey,
    allocation_bps: [u16; MAX_ROUTES], allowed_programs: Vec<Pubkey>,
    registry: &Account<ExecutorRegistry>,
) -> Result<()> {
    require!(allowed_programs.len() <= MAX_ALLOWED_PROGRAMS, ErrorCode::TooManyPrograms);
    validate_allocation(&allocation_bps)?;
    require!(agent != Pubkey::default(), ErrorCode::InvalidExecutor);
    require!(registry.approved.contains(&agent), ErrorCode::ExecutorNotApproved);
    vault.bump = bump;
    vault.owner = owner;
    vault.agent = agent;
    vault.allocation_bps = allocation_bps;
    vault.last_rebalance_ts = Clock::get()?.unix_timestamp;
    vault.allowed_programs = allowed_programs;
    Ok(())
}

fn initialize_default_executor_limits(limits: &mut Account<ExecutorLimits>, vault: Pubkey, bump: u8) {
    limits.vault = vault;
    limits.bump = bump;
    limits.enabled = true;
    limits.max_action_usdc = DEFAULT_EXECUTOR_LIMIT_USDC;
    limits.max_24h_volume_usdc = DEFAULT_EXECUTOR_LIMIT_USDC;
    limits.max_principal_usdc = DEFAULT_EXECUTOR_LIMIT_USDC;
    limits.hour_epoch = [0; EXECUTOR_VOLUME_HOURS];
    limits.hour_volume = [0; EXECUTOR_VOLUME_HOURS];
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

    pub fn init_exponent_position(ctx: Context<InitExponentPosition>, max_loss_bps: u16, max_slippage_bps: u16) -> Result<()> {
        exponent::init(ctx, max_loss_bps, max_slippage_bps)
    }
    pub fn set_exponent_policy(ctx: Context<SetExponentPolicy>, enabled: bool, max_loss_bps: u16, max_slippage_bps: u16) -> Result<()> {
        exponent::set_policy(ctx, enabled, max_loss_bps, max_slippage_bps)
    }
    pub fn exponent_buy_pt<'info>(ctx: Context<'_, '_, 'info, 'info, ExponentAction<'info>>, order: ExponentOrder) -> Result<()> {
        exponent::buy(ctx, order)
    }
    pub fn exponent_sell_pt<'info>(ctx: Context<'_, '_, 'info, 'info, ExponentAction<'info>>, order: ExponentOrder) -> Result<()> {
        exponent::exit(ctx, order, false)
    }
    pub fn exponent_redeem_pt<'info>(ctx: Context<'_, '_, 'info, 'info, ExponentAction<'info>>, order: ExponentOrder) -> Result<()> {
        exponent::exit(ctx, order, true)
    }
    pub fn recover_exponent(ctx: Context<RecoverExponent>, amount: u64) -> Result<()> {
        exponent::recover(ctx, amount)
    }

    pub fn initialize(
        ctx: Context<Initialize>,
        agent: Pubkey,
        allocation_bps: [u16; MAX_ROUTES],
        allowed_programs: Vec<Pubkey>,
    ) -> Result<()> {
        initialize_vault_state(&mut ctx.accounts.vault, ctx.bumps.vault,
            ctx.accounts.owner.key(), agent, allocation_bps, allowed_programs,
            &ctx.accounts.executor_registry)
    }

    /// Current UI: creates a Safe and its default 1,000 USDC policy atomically.
    /// The original `initialize` ABI remains available for already-open client tabs.
    pub fn initialize_with_limits(
        ctx: Context<InitializeWithLimits>,
        agent: Pubkey,
        allocation_bps: [u16; MAX_ROUTES],
        allowed_programs: Vec<Pubkey>,
    ) -> Result<()> {
        initialize_vault_state(&mut ctx.accounts.vault, ctx.bumps.vault,
            ctx.accounts.owner.key(), agent, allocation_bps, allowed_programs,
            &ctx.accounts.executor_registry)?;
        initialize_default_executor_limits(&mut ctx.accounts.executor_limits,
            ctx.accounts.vault.key(), ctx.bumps.executor_limits);
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

    /// Owner-only policy. Until this PDA exists and is enabled, an executor cannot move USDC.
    pub fn set_executor_limits(
        ctx: Context<SetExecutorLimits>,
        max_action_usdc: u64,
        max_24h_volume_usdc: u64,
        max_principal_usdc: u64,
        enabled: bool,
    ) -> Result<()> {
        if enabled {
            require!(max_action_usdc > 0 && max_24h_volume_usdc > 0 && max_principal_usdc > 0,
                ErrorCode::InvalidExecutorLimits);
            require!(max_24h_volume_usdc >= max_action_usdc, ErrorCode::InvalidExecutorLimits);
        }
        let limits = &mut ctx.accounts.executor_limits;
        if limits.vault == Pubkey::default() {
            limits.vault = ctx.accounts.vault.key();
            limits.bump = ctx.bumps.executor_limits;
        }
        require_keys_eq!(limits.vault, ctx.accounts.vault.key(), ErrorCode::InvalidExecutorLimits);
        limits.max_action_usdc = max_action_usdc;
        limits.max_24h_volume_usdc = max_24h_volume_usdc;
        limits.max_principal_usdc = max_principal_usdc;
        limits.enabled = enabled;
        Ok(())
    }

    /// One global executor registry per program. Only the current config admin can initialize it.
    pub fn init_executor_registry(
        ctx: Context<InitExecutorRegistry>, default_executor: Pubkey, approved: Vec<Pubkey>
    ) -> Result<()> {
        validate_executors(default_executor, &approved)?;
        let registry = &mut ctx.accounts.executor_registry;
        registry.bump = ctx.bumps.executor_registry;
        registry.default_executor = default_executor;
        registry.approved = approved;
        Ok(())
    }

    /// Replacing the list can approve, revoke, or pause executors without a program upgrade.
    pub fn set_executor_registry(
        ctx: Context<SetExecutorRegistry>, default_executor: Pubkey, approved: Vec<Pubkey>
    ) -> Result<()> {
        validate_executors(default_executor, &approved)?;
        let registry = &mut ctx.accounts.executor_registry;
        registry.default_executor = default_executor;
        registry.approved = approved;
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
        if agent != Pubkey::default() {
            require!(ctx.accounts.executor_registry.approved.contains(&agent), ErrorCode::ExecutorNotApproved);
        }
        ctx.accounts.vault.agent = agent;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!exponent::protected_mint(&ctx.accounts.usdc_mint.key()), exponent::ExponentError::ProtectedAsset);
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
        require!(!exponent::protected_mint(&ctx.accounts.mint.key()), exponent::ExponentError::ProtectedAsset);
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
        require!(!exponent::protected_mint(&ctx.accounts.usdc_mint.key()), exponent::ExponentError::ProtectedAsset);
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
        require!(!exponent::protected_mint(&ctx.accounts.mint.key()), exponent::ExponentError::ProtectedAsset);
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
        exponent::protect_generic(vault, ctx.remaining_accounts)?;
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
        exponent::protect_generic(vault, ctx.remaining_accounts)?;
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
        require_owner_or_agent(vault, &ctx.accounts.authority.key(), &ctx.accounts.executor_registry)?;
        let (rem, mut policy) = if ctx.accounts.authority.key() == vault.owner {
            (ctx.remaining_accounts, None)
        } else {
            let (policy_info, kamino_accounts) = ctx.remaining_accounts.split_last()
                .ok_or(ErrorCode::ExecutorLimitsMissing)?;
            (kamino_accounts, Some((policy_info, executor_policy_from_tail(vault, policy_info)?)))
        };
        let target_bps = vault.allocation_bps[ROUTE_KAMINO_USDC];
        require!(target_bps > 0, ErrorCode::RouteDisabled);

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
        let principal_after = ctx.accounts.vault.route_principal[ROUTE_KAMINO_USDC]
            .checked_add(deposited).ok_or(ErrorCode::ExecutorPositionLimit)?;
        if ctx.accounts.authority.key() != ctx.accounts.vault.owner {
            require!(principal_within_target(&ctx.accounts.vault, ROUTE_KAMINO_USDC,
                principal_after, idle_after), ErrorCode::AllocationExceeded);
        }
        charge_executor_volume(&ctx.accounts.vault, &ctx.accounts.authority.key(),
            policy.as_mut().map(|(_, limits)| limits), deposited,
            Some(total_principal_after(&ctx.accounts.vault, ROUTE_KAMINO_USDC, principal_after)),
            Clock::get()?.unix_timestamp)?;
        if let Some((policy_info, limits)) = policy.as_ref() {
            save_executor_policy(policy_info, limits)?;
        }
        let vault = &mut ctx.accounts.vault;
        vault.route_principal[ROUTE_KAMINO_USDC] = principal_after;
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
        require_owner_or_agent(&ctx.accounts.vault, &ctx.accounts.authority.key(), &ctx.accounts.executor_registry)?;
        let (rem, mut policy) = if ctx.accounts.authority.key() == ctx.accounts.vault.owner {
            (ctx.remaining_accounts, None)
        } else {
            let (policy_info, kamino_accounts) = ctx.remaining_accounts.split_last()
                .ok_or(ErrorCode::ExecutorLimitsMissing)?;
            (kamino_accounts, Some((policy_info,
                executor_policy_from_tail(&ctx.accounts.vault, policy_info)?)))
        };
        let (discriminator, fixed) = if from_reserve {
            (KVAULT_WITHDRAW, KV_WITHDRAW_FULL_FIXED_ACCOUNTS)
        } else {
            (KVAULT_WITHDRAW_FROM_AVAILABLE, KV_WITHDRAW_AVAILABLE_FIXED_ACCOUNTS)
        };
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

        charge_executor_volume(&ctx.accounts.vault, &ctx.accounts.authority.key(),
            policy.as_mut().map(|(_, limits)| limits), received, None, Clock::get()?.unix_timestamp)?;
        if let Some((policy_info, limits)) = policy.as_ref() {
            save_executor_policy(policy_info, limits)?;
        }

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
    pub fn close_safe<'info>(ctx: Context<'_, '_, 'info, 'info, CloseSafe<'info>>) -> Result<()> {
        // Legacy clients pass only owner + vault. Current clients append the
        // policy PDA so its refundable rent is returned in the same transaction.
        if let Some(policy_info) = ctx.remaining_accounts.first() {
            require!(ctx.remaining_accounts.len() == 1, ErrorCode::InvalidExecutorLimits);
            let vault_key = ctx.accounts.vault.key();
            let (expected, _) = Pubkey::find_program_address(
                &[b"executor_limits", vault_key.as_ref()], &crate::ID);
            require_keys_eq!(policy_info.key(), expected, ErrorCode::InvalidExecutorLimits);
            require!(policy_info.is_writable, ErrorCode::InvalidExecutorLimits);
            let policy = Account::<ExecutorLimits>::try_from(policy_info)?;
            require_keys_eq!(policy.vault, vault_key, ErrorCode::InvalidExecutorLimits);
            policy.close(ctx.accounts.owner.to_account_info())?;
        }
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

#[account]
#[derive(InitSpace)]
pub struct ExecutorRegistry {
    pub bump: u8,
    pub default_executor: Pubkey,
    #[max_len(16)]
    pub approved: Vec<Pubkey>,
}

/// Per-Safe owner policy. Every executor USDC movement shares one volume ledger across routes.
#[account]
#[derive(InitSpace)]
pub struct ExecutorLimits {
    pub vault: Pubkey,
    pub bump: u8,
    pub enabled: bool,
    pub max_action_usdc: u64,
    pub max_24h_volume_usdc: u64,
    pub max_principal_usdc: u64,
    pub hour_epoch: [i64; EXECUTOR_VOLUME_HOURS],
    pub hour_volume: [u64; EXECUTOR_VOLUME_HOURS],
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
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Account<'info, ExecutorRegistry>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(init_if_needed, payer = owner, associated_token::mint = usdc_mint,
        associated_token::authority = vault)]
    pub vault_usdc_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeWithLimits<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Account<'info, ExecutorRegistry>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(init_if_needed, payer = owner, associated_token::mint = usdc_mint,
        associated_token::authority = vault)]
    pub vault_usdc_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(init_if_needed, payer = owner, space = 8 + ExecutorLimits::INIT_SPACE,
        seeds = [b"executor_limits", vault.key().as_ref()], bump)]
    pub executor_limits: Account<'info, ExecutorLimits>,
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
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Account<'info, ExecutorRegistry>,
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
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Account<'info, ExecutorRegistry>,
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
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Account<'info, ExecutorRegistry>,
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
pub struct SetExecutorLimits<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + ExecutorLimits::INIT_SPACE,
        seeds = [b"executor_limits", vault.key().as_ref()],
        bump,
    )]
    pub executor_limits: Account<'info, ExecutorLimits>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitExecutorRegistry<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + ExecutorRegistry::INIT_SPACE,
        seeds = [b"executor_registry"],
        bump,
    )]
    pub executor_registry: Account<'info, ExecutorRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetExecutorRegistry<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Account<'info, ExecutorRegistry>,
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
    #[msg("Too many executor keys in the global whitelist")]
    TooManyExecutors,
    #[msg("The executor key cannot be the default pubkey")]
    InvalidExecutor,
    #[msg("Duplicate executor key in the global whitelist")]
    DuplicateExecutor,
    #[msg("Executor is not in the current admin whitelist")]
    ExecutorNotApproved,
    #[msg("Executor limits for this Safe are missing")]
    ExecutorLimitsMissing,
    #[msg("Executor limits do not belong to this Safe or are invalid")]
    InvalidExecutorLimits,
    #[msg("Executor is paused by the Safe owner")]
    ExecutorPaused,
    #[msg("Executor action exceeds its USDC limit")]
    ExecutorActionLimit,
    #[msg("Executor movement exceeds the rolling 24-hour USDC limit")]
    ExecutorVolumeLimit,
    #[msg("Executor deposit exceeds the Safe's principal limit")]
    ExecutorPositionLimit,
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

    fn test_limits() -> ExecutorLimits {
        ExecutorLimits {
            vault: Pubkey::new_unique(), bump: 0, enabled: true,
            max_action_usdc: 1_000, max_24h_volume_usdc: 1_000, max_principal_usdc: 1_000,
            hour_epoch: [0; EXECUTOR_VOLUME_HOURS], hour_volume: [0; EXECUTOR_VOLUME_HOURS],
        }
    }

    #[test]
    fn executor_volume_covers_repeated_deposit_and_exit_without_reset_on_limit_change() {
        let mut limits = test_limits();
        let now = 100 * SECONDS_PER_HOUR;
        charge_volume(&mut limits, 600, Some(600), now).unwrap();
        assert!(charge_volume(&mut limits, 500, Some(900), now).is_err());
        assert_eq!(limits.hour_volume[100 % EXECUTOR_VOLUME_HOURS], 600);
        assert!(charge_volume(&mut limits, 500, None, now + 23 * SECONDS_PER_HOUR).is_err());
        // Owner changes caps without clearing the spent ledger.
        limits.max_24h_volume_usdc = 700;
        assert!(charge_volume(&mut limits, 101, None, now + 23 * SECONDS_PER_HOUR).is_err());
        assert!(charge_volume(&mut limits, 101, None, now + 24 * SECONDS_PER_HOUR).is_err());
        charge_volume(&mut limits, 500, None, now + 25 * SECONDS_PER_HOUR).unwrap();
    }

    #[test]
    fn executor_action_position_and_pause_limits_fail_closed() {
        let mut limits = test_limits();
        assert!(charge_volume(&mut limits, 1_001, None, SECONDS_PER_HOUR).is_err());
        assert!(charge_volume(&mut limits, 1, Some(1_001), SECONDS_PER_HOUR).is_err());
        assert_eq!(limits.hour_volume[1], 0);
        limits.enabled = false;
        assert!(charge_volume(&mut limits, 1, None, SECONDS_PER_HOUR).is_err());
    }

    #[test]
    fn repeated_executor_deposits_cannot_exceed_owner_allocation() {
        let mut vault = Vault {
            bump: 0, owner: Pubkey::new_unique(), agent: Pubkey::new_unique(),
            allocation_bps: [5_000, 0, 0, 0, 0, 0, 0, 0], last_rebalance_ts: 0,
            allowed_programs: Vec::new(), route_principal: [0; MAX_ROUTES],
        };
        assert!(principal_within_target(&vault, ROUTE_KAMINO_USDC, 50, 50));
        vault.route_principal[ROUTE_KAMINO_USDC] = 50;
        assert!(!principal_within_target(&vault, ROUTE_KAMINO_USDC, 75, 25));
        assert!(principal_within_target(&vault, ROUTE_KAMINO_USDC, 50, 50));
    }
}
