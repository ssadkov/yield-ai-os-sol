//! Owner generic CPI policy.
//!
//! Generic CPI (`execute_swap_cpi` / `execute_protocol_cpi`) lets the Safe PDA sign an arbitrary
//! instruction of an allowlisted program. That is an owner-only escape hatch, not a fund route.
//! This module bounds it:
//! - programs that can move or re-own Safe accounts directly are never allowed (`denied_program`);
//! - programs with a typed Safe route must use it (`dedicated_program`), anywhere in the call;
//! - adding a program takes two owner signatures at least `ALLOWLIST_DELAY_SECONDS` apart,
//!   so one malicious transaction cannot add a program and use it; removal is immediate;
//! - after the CPI every Safe-owned SPL token account that was passed in must still exist, still
//!   belong to the Safe, have no delegate and an unchanged close authority;
//! - Safe-owned Token-2022 accounts (Orca position NFTs, xStocks) cannot be passed at all.
use super::*;

/// Two days between proposing and activating a new allowlisted program.
pub const ALLOWLIST_DELAY_SECONDS: i64 = 48 * 3_600;
pub const MAX_PENDING_PROGRAMS: usize = 4;
const LOADER_V4: Pubkey = pubkey!("LoaderV411111111111111111111111111111111111");
const BPF_LOADER_2: Pubkey = pubkey!("BPFLoader2111111111111111111111111111111111");
const BPF_LOADER_1: Pubkey = pubkey!("BPFLoader1111111111111111111111111111111111");

/// Programs a Safe may never call through generic CPI, as the target or anywhere in the call.
/// Token programs: transfer, approve, close, set_authority on Safe accounts. System/ATA: no use
/// case. This program and the loaders: re-entrancy and upgrade paths.
pub fn denied_program(program: &Pubkey) -> bool {
    [
        anchor_spl::token::ID,
        anchor_spl::token_2022::ID,
        anchor_lang::system_program::ID,
        anchor_spl::associated_token::ID,
        crate::ID,
        bpf_loader_upgradeable::ID,
        BPF_LOADER_2,
        BPF_LOADER_1,
        LOADER_V4,
    ]
    .contains(program)
}

/// Denied programs that may still be passed as plain accounts (swaps and account creation need
/// them) but never be the target. Token-2022, this program and the loaders are refused anywhere.
pub fn passable_program(program: &Pubkey) -> bool {
    [anchor_spl::token::ID, anchor_lang::system_program::ID, anchor_spl::associated_token::ID].contains(program)
}

/// Programs with typed Safe routes and their own accounting. They may not appear anywhere in a
/// generic CPI, otherwise principal, fee and position accounting could be bypassed.
pub fn dedicated_program(program: &Pubkey) -> bool {
    [KAMINO_KVAULT_PROGRAM, exponent::CORE, exponent::CLMM, exponent::GENERIC_SY, orca::ORCA_PROGRAM]
        .contains(program)
}

#[account]
#[derive(InitSpace)]
pub struct CpiPolicy {
    pub vault: Pubkey,
    pub bump: u8,
    pub pending: [PendingProgram; MAX_PENDING_PROGRAMS],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct PendingProgram {
    pub program: Pubkey,
    pub activate_at: i64,
}

#[event]
pub struct AllowlistProposal {
    pub vault: Pubkey,
    pub program: Pubkey,
    pub activate_at: i64,
}

#[derive(Accounts)]
pub struct ProposeAllowedProgram<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(init_if_needed, payer = owner, space = 8 + CpiPolicy::INIT_SPACE,
        seeds = [b"cpi_policy", vault.key().as_ref()], bump)]
    pub cpi_policy: Account<'info, CpiPolicy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ChangePendingProgram<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [b"cpi_policy", vault.key().as_ref()], bump = cpi_policy.bump,
        constraint = cpi_policy.vault == vault.key() @ CpiPolicyError::InvalidPolicy)]
    pub cpi_policy: Account<'info, CpiPolicy>,
}

/// Pure check used by `propose`. Returns the slot to write.
pub fn proposal_slot(
    pending: &[PendingProgram; MAX_PENDING_PROGRAMS],
    allowed: &[Pubkey],
    program: &Pubkey,
) -> Result<usize> {
    require!(*program != Pubkey::default(), CpiPolicyError::InvalidProgram);
    require!(!denied_program(program), CpiPolicyError::ProgramDenied);
    require!(!dedicated_program(program), ErrorCode::UseDedicatedInstruction);
    require!(!allowed.contains(program), CpiPolicyError::AlreadyAllowed);
    require!(!pending.iter().any(|p| p.program == *program), CpiPolicyError::AlreadyPending);
    require!(allowed.len() < MAX_ALLOWED_PROGRAMS, ErrorCode::TooManyPrograms);
    pending
        .iter()
        .position(|p| p.program == Pubkey::default())
        .ok_or_else(|| error!(CpiPolicyError::TooManyPending))
}

/// Pure check used by `activate`. Returns the slot to clear.
pub fn activation_slot(
    pending: &[PendingProgram; MAX_PENDING_PROGRAMS],
    allowed: &[Pubkey],
    program: &Pubkey,
    now: i64,
) -> Result<usize> {
    let slot = pending
        .iter()
        .position(|p| p.program == *program && *program != Pubkey::default())
        .ok_or_else(|| error!(CpiPolicyError::NotPending))?;
    require!(now >= pending[slot].activate_at, CpiPolicyError::TimelockActive);
    // Re-check: the deny lists may have grown in an upgrade since the proposal.
    require!(!denied_program(program), CpiPolicyError::ProgramDenied);
    require!(!dedicated_program(program), ErrorCode::UseDedicatedInstruction);
    require!(allowed.len() < MAX_ALLOWED_PROGRAMS, ErrorCode::TooManyPrograms);
    Ok(slot)
}

pub fn propose(ctx: Context<ProposeAllowedProgram>, program: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_key = ctx.accounts.vault.key();
    let policy = &mut ctx.accounts.cpi_policy;
    if policy.vault == Pubkey::default() {
        policy.vault = vault_key;
        policy.bump = ctx.bumps.cpi_policy;
    }
    require_keys_eq!(policy.vault, vault_key, CpiPolicyError::InvalidPolicy);
    let slot = proposal_slot(&policy.pending, &ctx.accounts.vault.allowed_programs, &program)?;
    let activate_at = now.checked_add(ALLOWLIST_DELAY_SECONDS).ok_or(CpiPolicyError::InvalidProgram)?;
    policy.pending[slot] = PendingProgram { program, activate_at };
    emit!(AllowlistProposal { vault: vault_key, program, activate_at });
    Ok(())
}

pub fn activate(ctx: Context<ChangePendingProgram>, program: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let slot = activation_slot(&ctx.accounts.cpi_policy.pending, &ctx.accounts.vault.allowed_programs, &program, now)?;
    ctx.accounts.cpi_policy.pending[slot] = PendingProgram::default();
    ctx.accounts.vault.allowed_programs.push(program);
    Ok(())
}

pub fn cancel(ctx: Context<ChangePendingProgram>, program: Pubkey) -> Result<()> {
    let policy = &mut ctx.accounts.cpi_policy;
    let slot = policy
        .pending
        .iter()
        .position(|p| p.program == program && program != Pubkey::default())
        .ok_or_else(|| error!(CpiPolicyError::NotPending))?;
    policy.pending[slot] = PendingProgram::default();
    Ok(())
}

/// `set_allowed_programs` may only remove entries. Additions go through propose/activate.
pub fn require_removal_only(current: &[Pubkey], next: &[Pubkey]) -> Result<()> {
    require!(next.len() <= current.len(), CpiPolicyError::UseTimelock);
    for (index, program) in next.iter().enumerate() {
        require!(current.contains(program), CpiPolicyError::UseTimelock);
        require!(!next[..index].contains(program), CpiPolicyError::InvalidProgram);
    }
    Ok(())
}

/// Snapshot of a Safe-owned SPL token account before the CPI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenSnapshot {
    pub owner: Pubkey,
    pub delegate: Option<Pubkey>,
    pub close_authority: Option<Pubkey>,
}

/// Parse a classic SPL token account (165 bytes). Returns None for anything else.
pub fn parse_spl_account(data: &[u8]) -> Option<TokenSnapshot> {
    if data.len() != 165 || data[108] == 0 {
        return None; // wrong size or uninitialized
    }
    let key = |o: usize| Pubkey::new_from_array(data[o..o + 32].try_into().unwrap());
    let option = |tag: usize, o: usize| -> Option<Pubkey> {
        if data[tag..tag + 4] == [1, 0, 0, 0] { Some(key(o)) } else { None }
    };
    Some(TokenSnapshot { owner: key(32), delegate: option(72, 76), close_authority: option(129, 133) })
}

/// The after-state may not re-own, delegate or change close authority of a Safe account.
pub fn snapshot_still_safe(before: &TokenSnapshot, after: Option<TokenSnapshot>, safe: &Pubkey) -> bool {
    match after {
        Some(after) => after.owner == *safe && after.delegate.is_none()
            && after.close_authority == before.close_authority,
        None => false,
    }
}

/// Shared body of both generic CPI entrypoints.
pub fn run_generic_cpi(vault: &mut Account<Vault>, authority: &Pubkey, rem: &[AccountInfo], data: Vec<u8>) -> Result<()> {
    require_keys_eq!(*authority, vault.owner, ErrorCode::Unauthorized);
    require!(!rem.is_empty(), ErrorCode::MissingCpiProgram);
    let program_id = rem[0].key();
    require!(!denied_program(&program_id), CpiPolicyError::ProgramDenied);
    require!(!dedicated_program(&program_id), ErrorCode::UseDedicatedInstruction);
    require!(vault.allowed_programs.iter().any(|p| *p == program_id), ErrorCode::ProgramNotWhitelisted);
    exponent::protect_generic(vault, rem)?;
    let vault_key = vault.key();
    let shares_ata = kamino_shares_ata(&vault_key);
    let mut snapshots: Vec<(usize, TokenSnapshot)> = Vec::new();
    for (index, account) in rem.iter().enumerate() {
        let key = account.key();
        require!(key != shares_ata, ErrorCode::UseDedicatedInstruction);
        require!(!dedicated_program(&key), ErrorCode::UseDedicatedInstruction);
        if index > 0 && denied_program(&key) && !passable_program(&key) {
            return err!(CpiPolicyError::ProgramDenied);
        }
        if *account.owner == anchor_spl::token_2022::ID {
            let data = account.try_borrow_data()?;
            if data.len() >= 64 && data[32..64] == vault_key.to_bytes() {
                return err!(CpiPolicyError::Token2022NotAllowed);
            }
        }
        if *account.owner == anchor_spl::token::ID {
            if let Some(snapshot) = parse_spl_account(&account.try_borrow_data()?) {
                if snapshot.owner == vault_key {
                    snapshots.push((index, snapshot));
                }
            }
        }
    }
    let metas: Vec<AccountMeta> = rem[1..]
        .iter()
        .map(|a| {
            let is_signer = a.key() == vault_key || a.is_signer;
            if a.is_writable { AccountMeta::new(a.key(), is_signer) } else { AccountMeta::new_readonly(a.key(), is_signer) }
        })
        .collect();
    let ix = Instruction { program_id, accounts: metas, data };
    let seeds: &[&[u8]] = &[b"vault", vault.owner.as_ref(), &[vault.bump]];
    invoke_signed(&ix, rem, &[seeds])?;
    for (index, before) in snapshots {
        let account = &rem[index];
        let after = if *account.owner == anchor_spl::token::ID && account.lamports() > 0 {
            parse_spl_account(&account.try_borrow_data()?)
        } else {
            None
        };
        require!(snapshot_still_safe(&before, after, &vault_key), CpiPolicyError::SafeAccountChanged);
    }
    vault.last_rebalance_ts = Clock::get()?.unix_timestamp;
    Ok(())
}

#[error_code(offset = 7300)]
pub enum CpiPolicyError {
    #[msg("This program can never be called through generic CPI")] ProgramDenied,
    #[msg("Invalid program id")] InvalidProgram,
    #[msg("Program is already allowlisted")] AlreadyAllowed,
    #[msg("Program is already pending")] AlreadyPending,
    #[msg("Too many pending programs")] TooManyPending,
    #[msg("Program is not pending")] NotPending,
    #[msg("Allowlist timelock has not expired")] TimelockActive,
    #[msg("Additions must use propose/activate; set_allowed_programs only removes")] UseTimelock,
    #[msg("CPI policy account does not belong to this Safe")] InvalidPolicy,
    #[msg("Safe-owned Token-2022 accounts cannot be used in generic CPI")] Token2022NotAllowed,
    #[msg("Generic CPI changed owner, delegate or close authority of a Safe token account")] SafeAccountChanged,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spl_account(owner: Pubkey, delegate: Option<Pubkey>, close: Option<Pubkey>) -> Vec<u8> {
        let mut d = vec![0u8; 165];
        d[32..64].copy_from_slice(owner.as_ref());
        if let Some(k) = delegate { d[72..76].copy_from_slice(&[1, 0, 0, 0]); d[76..108].copy_from_slice(k.as_ref()); }
        d[108] = 1; // initialized
        if let Some(k) = close { d[129..133].copy_from_slice(&[1, 0, 0, 0]); d[133..165].copy_from_slice(k.as_ref()); }
        d
    }

    #[test]
    fn deny_and_dedicated_lists_cover_dangerous_programs() {
        for p in [anchor_spl::token::ID, anchor_spl::token_2022::ID, anchor_lang::system_program::ID,
            anchor_spl::associated_token::ID, crate::ID, bpf_loader_upgradeable::ID] {
            assert!(denied_program(&p));
        }
        for p in [KAMINO_KVAULT_PROGRAM, exponent::CORE, exponent::CLMM, orca::ORCA_PROGRAM] {
            assert!(dedicated_program(&p));
        }
        assert!(!denied_program(&Pubkey::new_unique()));
        assert!(passable_program(&anchor_spl::token::ID) && !passable_program(&anchor_spl::token_2022::ID));
        assert!(!passable_program(&crate::ID) && !passable_program(&bpf_loader_upgradeable::ID));
    }

    #[test]
    fn proposal_rejects_denied_duplicate_and_full() {
        let mut pending = [PendingProgram::default(); MAX_PENDING_PROGRAMS];
        let p = Pubkey::new_unique();
        assert!(proposal_slot(&pending, &[], &anchor_spl::token::ID).is_err());
        assert!(proposal_slot(&pending, &[], &orca::ORCA_PROGRAM).is_err());
        assert!(proposal_slot(&pending, &[p], &p).is_err());
        assert_eq!(proposal_slot(&pending, &[], &p).unwrap(), 0);
        pending[0] = PendingProgram { program: p, activate_at: 10 };
        assert!(proposal_slot(&pending, &[], &p).is_err());
        for slot in pending.iter_mut() { slot.program = Pubkey::new_unique(); }
        assert!(proposal_slot(&pending, &[], &Pubkey::new_unique()).is_err());
        let sixteen: Vec<Pubkey> = (0..16).map(|_| Pubkey::new_unique()).collect();
        assert!(proposal_slot(&[PendingProgram::default(); 4], &sixteen, &Pubkey::new_unique()).is_err());
    }

    #[test]
    fn activation_waits_for_the_timelock() {
        let p = Pubkey::new_unique();
        let mut pending = [PendingProgram::default(); MAX_PENDING_PROGRAMS];
        pending[2] = PendingProgram { program: p, activate_at: 1_000 + ALLOWLIST_DELAY_SECONDS };
        assert!(activation_slot(&pending, &[], &p, 1_000).is_err());
        assert!(activation_slot(&pending, &[], &p, 1_000 + ALLOWLIST_DELAY_SECONDS - 1).is_err());
        assert_eq!(activation_slot(&pending, &[], &p, 1_000 + ALLOWLIST_DELAY_SECONDS).unwrap(), 2);
        assert!(activation_slot(&pending, &[], &Pubkey::default(), i64::MAX).is_err());
        assert!(activation_slot(&pending, &[], &Pubkey::new_unique(), i64::MAX).is_err());
    }

    #[test]
    fn set_allowed_programs_can_only_remove() {
        let (a, b, c) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        assert!(require_removal_only(&[a, b], &[a]).is_ok());
        assert!(require_removal_only(&[a, b], &[]).is_ok());
        assert!(require_removal_only(&[a, b], &[b, a]).is_ok());
        assert!(require_removal_only(&[a, b], &[a, c]).is_err());
        assert!(require_removal_only(&[a], &[a, a]).is_err());
        assert!(require_removal_only(&[], &[a]).is_err());
    }

    #[test]
    fn token_account_invariants_catch_reown_delegate_close() {
        let safe = Pubkey::new_unique();
        let attacker = Pubkey::new_unique();
        let before = parse_spl_account(&spl_account(safe, None, None)).unwrap();
        assert!(snapshot_still_safe(&before, parse_spl_account(&spl_account(safe, None, None)), &safe));
        assert!(!snapshot_still_safe(&before, parse_spl_account(&spl_account(attacker, None, None)), &safe));
        assert!(!snapshot_still_safe(&before, parse_spl_account(&spl_account(safe, Some(attacker), None)), &safe));
        assert!(!snapshot_still_safe(&before, parse_spl_account(&spl_account(safe, None, Some(attacker))), &safe));
        assert!(!snapshot_still_safe(&before, None, &safe));
        assert!(parse_spl_account(&[0u8; 165]).is_none());
        assert!(parse_spl_account(&[0u8; 170]).is_none());
    }
}
