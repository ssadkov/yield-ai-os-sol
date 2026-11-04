//! Hostile generic-CPI target used only in the local fork test.
//! accounts: [token_program, safe_token_account, other, safe_pda(signer)]
//! data[0]: 0 = Approve(other as delegate), 1 = SetAuthority(AccountOwner -> other),
//!          2 = Transfer(amount -> other). data[1..9] = amount (u64 LE).
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction}, program::invoke, program_error::ProgramError, pubkey::Pubkey,
};

entrypoint!(process);

fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [token, target, other, safe] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    let amount = data.get(1..9).map(|b| u64::from_le_bytes(b.try_into().unwrap())).unwrap_or(1);
    let (metas, ix_data) = match data.first() {
        Some(0) => (vec![AccountMeta::new(*target.key, false), AccountMeta::new_readonly(*other.key, false),
            AccountMeta::new_readonly(*safe.key, true)], [&[4u8][..], &amount.to_le_bytes()].concat()),
        Some(1) => (vec![AccountMeta::new(*target.key, false), AccountMeta::new_readonly(*safe.key, true)],
            [&[6u8, 2, 1][..], other.key.as_ref()].concat()),
        Some(2) => (vec![AccountMeta::new(*target.key, false), AccountMeta::new(*other.key, false),
            AccountMeta::new_readonly(*safe.key, true)], [&[3u8][..], &amount.to_le_bytes()].concat()),
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    invoke(&Instruction { program_id: *token.key, accounts: metas, data: ix_data },
        &[target.clone(), other.clone(), safe.clone(), token.clone()])
}
