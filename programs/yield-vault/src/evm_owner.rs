use anchor_lang::prelude::*;
use solana_keccak_hasher as keccak;
use solana_secp256k1_recover::secp256k1_recover;

use crate::{ID, MAX_ROUTES};

#[cfg(feature = "devnet")]
pub const GENESIS_HASH: [u8; 32] = [
    0xce, 0x59, 0xdb, 0x50, 0x80, 0xfc, 0x2c, 0x6d, 0x3b, 0xcf, 0x7c, 0xa9, 0x07, 0x12, 0xd3, 0xc2,
    0xe5, 0xe6, 0xc2, 0x8f, 0x27, 0xf0, 0xdf, 0xbb, 0x99, 0x53, 0xbd, 0xb0, 0x89, 0x4c, 0x03, 0xab,
];

#[cfg(not(feature = "devnet"))]
pub const GENESIS_HASH: [u8; 32] = [
    0x45, 0x29, 0x69, 0x98, 0xa6, 0xf8, 0xe2, 0xa7, 0x84, 0xdb, 0x5d, 0x9f, 0x95, 0xe1, 0x8f, 0xc2,
    0x3f, 0x70, 0x44, 0x1a, 0x10, 0x39, 0x44, 0x68, 0x01, 0x08, 0x98, 0x79, 0xb0, 0x8c, 0x7e, 0xf0,
];

/// floor(secp256k1 curve order / 2). The Solana recover syscall does not enforce low-s.
const HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

fn word_u64(value: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn allocation_hash(allocation_bps: &[u16; MAX_ROUTES]) -> [u8; 32] {
    let mut words = [0u8; MAX_ROUTES * 32];
    for (index, value) in allocation_bps.iter().enumerate() {
        words[index * 32 + 30..index * 32 + 32].copy_from_slice(&value.to_be_bytes());
    }
    keccak::hash(&words).to_bytes()
}

fn domain_separator() -> [u8; 32] {
    let domain_type =
        keccak::hash(b"EIP712Domain(string name,string version,bytes32 salt)").to_bytes();
    let name = keccak::hash(b"Yield AI Safe").to_bytes();
    let version = keccak::hash(b"1").to_bytes();
    let program_id = ID.to_bytes();
    keccak::hashv(&[&domain_type, &name, &version, &program_id]).to_bytes()

}

/// EIP-712 `SetAllocation(bytes32 genesisHash,bytes32 vault,uint16[8]
/// allocationBps,uint64 nonce,uint64 deadline)`. `salt` is the program ID bytes.
pub fn set_allocation_digest(
    vault: &Pubkey,
    allocation_bps: &[u16; MAX_ROUTES],
    nonce: u64,
    deadline: u64,
) -> [u8; 32] {
    let domain = domain_separator();

    let message_type = keccak::hash(
        b"SetAllocation(bytes32 genesisHash,bytes32 vault,uint16[8] allocationBps,uint64 nonce,uint64 deadline)"
    ).to_bytes();
    let vault_bytes = vault.to_bytes();
    let allocations = allocation_hash(allocation_bps);
    let nonce_word = word_u64(nonce);
    let deadline_word = word_u64(deadline);
    let message = keccak::hashv(&[
        &message_type,
        &GENESIS_HASH,
        &vault_bytes,
        &allocations,
        &nonce_word,
        &deadline_word,
    ])
    .to_bytes();
    keccak::hashv(&[b"\x19\x01", &domain, &message]).to_bytes()
}

pub fn verify_set_allocation(
    eth_address: &[u8; 20],
    vault: &Pubkey,
    current_nonce: u64,
    allocation_bps: &[u16; MAX_ROUTES],
    nonce: u64,
    deadline: u64,
    signature: &[u8; 65],
    now: i64,
) -> Result<()> {
    let digest = set_allocation_digest(vault, allocation_bps, nonce, deadline);
    verify_intent(eth_address, &digest, current_nonce, nonce, deadline, signature, now)
}

/// A distinct action type, sharing the Safe nonce with allocation.
pub fn withdraw_usdc_digest(
    vault: &Pubkey, mint: &Pubkey, amount_raw: u64,
    recipient_token_account: &Pubkey, recipient_owner: &Pubkey,
    nonce: u64, deadline: u64,
) -> [u8; 32] {
    let domain = domain_separator();
    let message_type = keccak::hash(b"WithdrawUsdc(bytes32 genesisHash,bytes32 vault,bytes32 mint,uint64 amountRaw,bytes32 recipientTokenAccount,bytes32 recipientOwner,uint64 nonce,uint64 deadline)").to_bytes();
    let message = keccak::hashv(&[
        &message_type, &GENESIS_HASH, &vault.to_bytes(), &mint.to_bytes(),
        &word_u64(amount_raw), &recipient_token_account.to_bytes(),
        &recipient_owner.to_bytes(), &word_u64(nonce), &word_u64(deadline),
    ]).to_bytes();
    keccak::hashv(&[b"\x19\x01", &domain, &message]).to_bytes()
}

/// Owner authorizes the exact first rent payer. Creation consumes nonce 1.
pub fn create_safe_digest(vault: &Pubkey, mint: &Pubkey, rent_payer: &Pubkey, nonce: u64, deadline: u64) -> [u8; 32] {
    let kind = keccak::hash(b"CreateSafe(bytes32 genesisHash,bytes32 vault,bytes32 mint,bytes32 rentPayer,uint64 nonce,uint64 deadline)").to_bytes();
    let message = keccak::hashv(&[&kind, &GENESIS_HASH, &vault.to_bytes(), &mint.to_bytes(), &rent_payer.to_bytes(), &word_u64(nonce), &word_u64(deadline)]).to_bytes();
    keccak::hashv(&[b"\x19\x01", &domain_separator(), &message]).to_bytes()
}

/// Competes at the same next nonce as pending actions. Cancellation cannot undo an executed action.
pub fn cancel_intents_digest(vault: &Pubkey, nonce: u64, deadline: u64) -> [u8; 32] {
    let kind = keccak::hash(b"CancelIntents(bytes32 genesisHash,bytes32 vault,uint64 nonce,uint64 deadline)").to_bytes();
    let message = keccak::hashv(&[&kind, &GENESIS_HASH, &vault.to_bytes(), &word_u64(nonce), &word_u64(deadline)]).to_bytes();
    keccak::hashv(&[b"\x19\x01", &domain_separator(), &message]).to_bytes()
}

pub fn verify_intent(
    eth_address: &[u8; 20], digest: &[u8; 32], current_nonce: u64,
    nonce: u64, deadline: u64, signature: &[u8; 65], now: i64,
) -> Result<()> {
    require!(
        now >= 0 && (now as u64) <= deadline,
        EvmOwnerError::SignatureExpired
    );
    require!(
        current_nonce.checked_add(1) == Some(nonce),
        EvmOwnerError::InvalidNonce
    );
    let recovery_id = match signature[64] {
        0 | 27 => 0,
        1 | 28 => 1,
        _ => return err!(EvmOwnerError::InvalidRecoveryId),
    };
    let s = &signature[32..64];
    require!(
        s.iter().any(|byte| *byte != 0) && s <= HALF_ORDER.as_slice(),
        EvmOwnerError::HighSignatureS
    );
    let public_key = secp256k1_recover(digest, recovery_id, &signature[..64])
        .map_err(|_| error!(EvmOwnerError::InvalidSignature))?;
    let public_hash = keccak::hash(&public_key.to_bytes()).to_bytes();
    require!(
        eth_address.as_slice() == &public_hash[12..],
        EvmOwnerError::WrongSigner
    );
    Ok(())
}

#[error_code]
pub enum EvmOwnerError {
    #[msg("EVM owner address cannot be zero")]
    ZeroAddress,
    #[msg("EVM signature expired")]
    SignatureExpired,
    #[msg("EVM Safe nonce must advance by exactly one")]
    InvalidNonce,
    #[msg("EVM signature recovery ID must be 0, 1, 27, or 28")]
    InvalidRecoveryId,
    #[msg("EVM signature s must be nonzero and low")]
    HighSignatureS,
    #[msg("Invalid EVM signature")]
    InvalidSignature,
    #[msg("EVM signature belongs to another owner")]
    WrongSigner,
    #[msg("EVM Safe creation requires an owner-signed CreateSafe intent")]
    OwnerSignatureRequired,
}

#[cfg(all(test, feature = "devnet"))]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn hex_bytes<const N: usize>(hex: &str) -> [u8; N] {
        assert_eq!(hex.len(), N * 2);
        let mut out = [0u8; N];
        for (index, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap();
        }
        out
    }

    fn vector() -> ([u8; 20], Pubkey, [u16; MAX_ROUTES], [u8; 65]) {
        // Signature and digest were produced by viem hashTypedData/signTypedData.
        // The ephemeral test private key is deliberately not stored.
        let owner = hex_bytes("d7bd5acfd8b726ccc99ad8d71983293638185619");
        let vault = Pubkey::from_str("9hoSB5kdEpF3ECuZwoaEHHYXfadJ7r8VyG9eCiB86uU1").unwrap();
        let allocation = [5_000, 0, 0, 0, 0, 0, 0, 0];
        let signature = hex_bytes("f78c3c552e7cbb4b3a4375add06c1595a85c86e07c88d7512755c3add007639b3f7c5a5b19da773c9eb20ff9076ee1e285748f457e3631e6df60ebc3ea077a281c");
        (owner, vault, allocation, signature)
    }

    #[test]
    fn viem_digest_and_recovery_match() {
        let (owner, vault, allocation, signature) = vector();
        assert_eq!(
            set_allocation_digest(&vault, &allocation, 1, 2_000_000_000),
            hex_bytes("3e2f382f9d990b8cdd4d2e25704c74cfce6818c48766c08b2155b16b304d6916")
        );
        verify_set_allocation(
            &owner,
            &vault,
            0,
            &allocation,
            1,
            2_000_000_000,
            &signature,
            1_800_000_000,
        )
        .unwrap();
    }

    #[test]
    fn replay_expiry_wrong_owner_and_tampering_fail() {
        let (owner, vault, allocation, signature) = vector();
        assert!(verify_set_allocation(
            &owner,
            &vault,
            1,
            &allocation,
            1,
            2_000_000_000,
            &signature,
            1_800_000_000
        )
        .is_err());
        assert!(verify_set_allocation(
            &owner,
            &vault,
            0,
            &allocation,
            1,
            2_000_000_000,
            &signature,
            2_000_000_001
        )
        .is_err());
        let mut other_owner = owner;
        other_owner[0] ^= 1;
        assert!(verify_set_allocation(
            &other_owner,
            &vault,
            0,
            &allocation,
            1,
            2_000_000_000,
            &signature,
            1_800_000_000
        )
        .is_err());
        let other_vault = Pubkey::new_unique();
        assert!(verify_set_allocation(
            &owner,
            &other_vault,
            0,
            &allocation,
            1,
            2_000_000_000,
            &signature,
            1_800_000_000
        )
        .is_err());
        let mut other_allocation = allocation;
        other_allocation[0] = 4_000;
        assert!(verify_set_allocation(
            &owner,
            &vault,
            0,
            &other_allocation,
            1,
            2_000_000_000,
            &signature,
            1_800_000_000
        )
        .is_err());
    }

    #[test]
    fn high_s_and_invalid_recovery_id_fail() {
        let (owner, vault, allocation, mut signature) = vector();
        signature[32] = 0x80;
        assert!(verify_set_allocation(
            &owner,
            &vault,
            0,
            &allocation,
            1,
            2_000_000_000,
            &signature,
            1_800_000_000
        )
        .is_err());
        signature[64] = 29;
        assert!(verify_set_allocation(
            &owner,
            &vault,
            0,
            &allocation,
            1,
            2_000_000_000,
            &signature,
            1_800_000_000
        )
        .is_err());
    }
}

#[cfg(test)]
mod withdrawal_tests {
    use super::*;
    use std::str::FromStr;
    // Public signatures only. Independently generated by viem; no test private key stored.
    fn field(name: &str) -> &'static str {
        let marker = format!("\"{}\": \"", name);
        include_str!("../tests/fixtures/evm-withdraw.json").split(&marker).nth(1).unwrap().split('"').next().unwrap()
    }
    fn hex<const N: usize>(value: &str) -> [u8; N] {
        let value = value.trim_start_matches("0x");
        assert_eq!(value.len(), 2 * N);
        let mut out = [0; N];
        for (i, byte) in out.iter_mut().enumerate() { *byte = u8::from_str_radix(&value[i*2..i*2+2], 16).unwrap(); }
        out
    }
    fn key(name: &str) -> Pubkey { Pubkey::from_str(field(name)).unwrap() }
    fn digest() -> [u8; 32] {
        withdraw_usdc_digest(&key("safe"), &key("mint"), 100_000,
            &key("recipientTokenAccount"), &key("recipientOwner"), 7, 2_000_000_000)
    }
    fn check(digest: &[u8; 32], signature: &[u8; 65]) -> Result<()> {
        verify_intent(&hex(field("owner")), digest, 6, 7, 2_000_000_000, signature, 1_800_000_000)
    }
    #[cfg(feature = "devnet")]
    #[test]
    fn viem_withdrawal_digest_and_signature_match() {
        assert_eq!(digest(), hex::<32>(field("digest")));
        check(&digest(), &hex(field("signature"))).unwrap();
    }
    #[cfg(not(feature = "devnet"))]
    #[test]
    fn devnet_withdrawal_cannot_authorize_mainnet() {
        assert_ne!(digest(), hex::<32>(field("digest")));
        assert!(check(&digest(), &hex(field("signature"))).is_err());
    }
    #[cfg(feature = "devnet")]
    #[test]
    fn amount_mint_safe_recipient_and_authority_tampering_fail() {
        let sig = hex(field("signature"));
        for changed in [
            withdraw_usdc_digest(&key("safe"), &key("mint"), 100_001, &key("recipientTokenAccount"), &key("recipientOwner"), 7, 2_000_000_000),
            withdraw_usdc_digest(&Pubkey::new_unique(), &key("mint"), 100_000, &key("recipientTokenAccount"), &key("recipientOwner"), 7, 2_000_000_000),
            withdraw_usdc_digest(&key("safe"), &Pubkey::new_unique(), 100_000, &key("recipientTokenAccount"), &key("recipientOwner"), 7, 2_000_000_000),
            withdraw_usdc_digest(&key("safe"), &key("mint"), 100_000, &Pubkey::new_unique(), &key("recipientOwner"), 7, 2_000_000_000),
            withdraw_usdc_digest(&key("safe"), &key("mint"), 100_000, &key("recipientTokenAccount"), &Pubkey::new_unique(), 7, 2_000_000_000),
            withdraw_usdc_digest(&key("safe"), &key("mint"), 100_000, &key("recipientTokenAccount"), &key("recipientOwner"), 8, 2_000_000_000),
            withdraw_usdc_digest(&key("safe"), &key("mint"), 100_000, &key("recipientTokenAccount"), &key("recipientOwner"), 7, 2_000_000_001),
        ] { assert!(check(&changed, &sig).is_err()); }
    }
    #[cfg(feature = "devnet")]
    #[test]
    fn wrong_domain_and_allocation_action_cannot_withdraw() {
        for name in ["wrongProgramSignature", "wrongClusterSignature", "allocationSignature"] {
            assert!(check(&digest(), &hex(field(name))).is_err());
        }
    }
    #[cfg(feature = "devnet")]
    #[test]
    fn wrong_owner_replay_expiry_and_nonce_overflow_fail() {
        let owner = hex(field("owner")); let sig = hex(field("signature")); let digest = digest();
        assert!(verify_intent(&[1; 20], &digest, 6, 7, 2_000_000_000, &sig, 1_800_000_000).is_err());
        assert!(verify_intent(&owner, &digest, 7, 7, 2_000_000_000, &sig, 1_800_000_000).is_err());
        assert!(verify_intent(&owner, &digest, 6, 7, 2_000_000_000, &sig, 2_000_000_001).is_err());
        assert!(verify_intent(&owner, &digest, u64::MAX, 0, 2_000_000_000, &sig, 1_800_000_000).is_err());
    }
    #[cfg(feature = "devnet")]
    #[test]
    fn canonical_signature_policy_is_enforced() {
        let original = hex::<65>(field("signature"));
        let mut normalized = original; normalized[64] -= 27;
        check(&digest(), &normalized).unwrap();
        let mut bad = original; bad[32..64].fill(0);
        assert!(check(&digest(), &bad).is_err());
        bad = original; bad[32] = 0x80;
        assert!(check(&digest(), &bad).is_err());
        bad = original; bad[64] = 29;
        assert!(check(&digest(), &bad).is_err());
        bad = original; bad[..32].fill(0);
        assert!(check(&digest(), &bad).is_err());
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::str::FromStr;
    fn field(name: &str) -> &'static str {
        let marker = format!("\"{}\": \"", name);
        include_str!("../tests/fixtures/evm-lifecycle.json").split(&marker).nth(1).unwrap().split('"').next().unwrap()
    }
    fn hex<const N: usize>(value: &str) -> [u8; N] {
        let value = value.trim_start_matches("0x"); assert_eq!(value.len(), N * 2); let mut out = [0; N];
        for (i, byte) in out.iter_mut().enumerate() { *byte = u8::from_str_radix(&value[i*2..i*2+2], 16).unwrap(); } out
    }
    fn key(name: &str) -> Pubkey { Pubkey::from_str(field(name)).unwrap() }
    #[cfg(feature = "devnet")]
    #[test]
    fn viem_create_and_cancel_vectors_match() {
        let create = create_safe_digest(&key("safe"), &key("mint"), &key("rentPayer"), 1, 2_000_000_000);
        let cancel = cancel_intents_digest(&key("safe"), 9, 2_000_000_000);
        assert_eq!(create, hex::<32>(field("createDigest"))); assert_eq!(cancel, hex::<32>(field("cancelDigest")));
        verify_intent(&hex(field("owner")), &create, 0, 1, 2_000_000_000, &hex(field("createSignature")), 1_800_000_000).unwrap();
        verify_intent(&hex(field("owner")), &cancel, 8, 9, 2_000_000_000, &hex(field("cancelSignature")), 1_800_000_000).unwrap();
    }
    #[cfg(feature = "devnet")]
    #[test]
    fn create_sponsor_mint_safe_nonce_deadline_and_action_are_bound() {
        let owner = hex(field("owner")); let sig = hex(field("createSignature"));
        for digest in [
            create_safe_digest(&key("safe"), &key("mint"), &Pubkey::new_unique(), 1, 2_000_000_000),
            create_safe_digest(&key("safe"), &Pubkey::new_unique(), &key("rentPayer"), 1, 2_000_000_000),
            create_safe_digest(&Pubkey::new_unique(), &key("mint"), &key("rentPayer"), 1, 2_000_000_000),
            create_safe_digest(&key("safe"), &key("mint"), &key("rentPayer"), 2, 2_000_000_000),
            create_safe_digest(&key("safe"), &key("mint"), &key("rentPayer"), 1, 2_000_000_001),
            cancel_intents_digest(&key("safe"), 1, 2_000_000_000),
        ] { assert!(verify_intent(&owner, &digest, 0, 1, 2_000_000_000, &sig, 1_800_000_000).is_err()); }
    }
    #[cfg(feature = "devnet")]
    #[test]
    fn cancel_replay_wrong_owner_expiry_and_cross_action_rejected() {
        let owner = hex(field("owner")); let sig = hex(field("cancelSignature")); let digest = cancel_intents_digest(&key("safe"), 9, 2_000_000_000);
        assert!(verify_intent(&owner, &digest, 9, 9, 2_000_000_000, &sig, 1_800_000_000).is_err());
        assert!(verify_intent(&[1;20], &digest, 8, 9, 2_000_000_000, &sig, 1_800_000_000).is_err());
        assert!(verify_intent(&owner, &digest, 8, 9, 2_000_000_000, &sig, 2_000_000_001).is_err());
        assert!(verify_intent(&owner, &withdraw_usdc_digest(&key("safe"), &key("mint"), 1, &key("rentPayer"), &key("rentPayer"), 9, 2_000_000_000), 8, 9, 2_000_000_000, &sig, 1_800_000_000).is_err());
    }
    #[cfg(not(feature = "devnet"))]
    #[test]
    fn devnet_lifecycle_signatures_rejected_under_mainnet_domain() {
        assert!(verify_intent(&hex(field("owner")), &create_safe_digest(&key("safe"), &key("mint"), &key("rentPayer"), 1, 2_000_000_000), 0, 1, 2_000_000_000, &hex(field("createSignature")), 1_800_000_000).is_err());
        assert!(verify_intent(&hex(field("owner")), &cancel_intents_digest(&key("safe"), 9, 2_000_000_000), 8, 9, 2_000_000_000, &hex(field("cancelSignature")), 1_800_000_000).is_err());
    }
}
