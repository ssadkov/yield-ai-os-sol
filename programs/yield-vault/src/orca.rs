//! Typed Orca Whirlpool routes: swaps between pinned assets and LP positions owned by the Safe.
//!
//! Nothing here takes a caller-chosen program, pool, output account or price reference:
//! - pools, vaults, mints, Orca oracle PDAs and Pyth feeds are constants reviewed on 2026-11-04;
//! - every token account the Safe sends from or receives into is the Safe's own ATA;
//! - swap floors and the pool-price band come from Pyth, not from the caller's quote;
//! - position NFTs live in the Safe's Token-2022 ATA and can only leave through
//!   `orca_lp_close` (burn) or the owner-only `orca_lp_exit_nft`;
//! - Yield AI takes `lp_fee_bps` (default 10%, max 20%) of collected trading fees only,
//!   never of principal. The rate is snapshotted per position when it is opened.
use super::*;
use anchor_spl::token_2022::Token2022;

pub const ORCA_PROGRAM: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const MEMO_PROGRAM: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ORCA_METADATA_UPDATE_AUTH: Pubkey = pubkey!("3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr");
/// sha256("account:PriceUpdateV2")[..8], checked against live feed accounts on 2026-11-04.
const PRICE_UPDATE_V2: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
const WHIRLPOOL_DISCRIMINATOR: [u8; 8] = [63, 149, 209, 12, 225, 128, 99, 9];
const POSITION_DISCRIMINATOR: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];

const IX_SWAP: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
const IX_OPEN_POSITION_WITH_TOKEN_EXTENSIONS: [u8; 8] = [212, 47, 95, 92, 114, 102, 131, 250];
const IX_INCREASE_LIQUIDITY_V2: [u8; 8] = [133, 29, 89, 223, 69, 238, 176, 10];
const IX_DECREASE_LIQUIDITY_V2: [u8; 8] = [58, 127, 188, 62, 79, 82, 196, 96];
const IX_UPDATE_FEES_AND_REWARDS: [u8; 8] = [154, 230, 250, 13, 236, 209, 75, 223];
const IX_COLLECT_FEES_V2: [u8; 8] = [207, 117, 95, 191, 229, 180, 226, 15];
const IX_CLOSE_POSITION_WITH_TOKEN_EXTENSIONS: [u8; 8] = [1, 182, 135, 59, 155, 25, 99, 223];

const MIN_SQRT_PRICE: u128 = 4_295_048_016;
const MAX_SQRT_PRICE: u128 = 79_226_673_515_401_279_992_447_579_055;

pub const ROUTE_ORCA_LP: usize = 2;
/// Sponsored Pyth feeds were 22-93 s old at review time; tune after observing mainnet cadence.
pub const ORACLE_MAX_AGE_SECONDS: i64 = 120;
/// Refuse prices whose confidence interval exceeds 1%.
pub const MAX_ORACLE_CONF_BPS: u128 = 100;
pub const DEFAULT_LP_FEE_BPS: u16 = 1_000;
pub const MAX_LP_FEE_BPS: u16 = 2_000;
pub const MAX_SLIPPAGE_BPS_CAP: u16 = 300;
pub const MAX_DEVIATION_BPS_CAP: u16 = 200;
pub const MAX_ORCA_POSITIONS: u8 = 4;
pub const MAX_OPENS_PER_DAY_CAP: u8 = 24;
const SECONDS_PER_DAY: i64 = 86_400;

pub struct Asset {
    pub mint: Pubkey,
    pub decimals: u8,
    pub feed: Pubkey,
    pub feed_id: [u8; 32],
}

pub const ASSET_USDC: usize = 0;
pub const ASSET_COUNT: usize = 3;
/// Index 0 must stay USDC: values and executor limits are in USDC base units.
pub const ASSETS: [Asset; ASSET_COUNT] = [
    Asset {
        mint: pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        decimals: 6,
        feed: pubkey!("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
        feed_id: [234, 160, 32, 198, 28, 196, 121, 113, 40, 19, 70, 28, 225, 83, 137, 74, 150, 166, 192, 11, 33, 237, 12, 252, 39, 152, 209, 249, 169, 233, 201, 74],
    },
    Asset { // cbBTC
        mint: pubkey!("cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij"),
        decimals: 8,
        feed: pubkey!("7oqYpv5YbjJ2PEsNeVVB5ZEZ8ZE6ufkj8hAvAiaiftbe"),
        feed_id: [40, 23, 215, 191, 229, 198, 75, 142, 169, 86, 233, 162, 111, 87, 62, 246, 78, 114, 228, 215, 137, 31, 45, 106, 249, 188, 201, 63, 122, 255, 154, 151],
    },
    Asset { // WBTC (Wormhole)
        mint: pubkey!("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"),
        decimals: 8,
        feed: pubkey!("9gNX5vguzarZZPjTnE1hWze3s6UsZ7dsU3UnAmKPnMHG"),
        feed_id: [201, 216, 176, 117, 165, 198, 147, 3, 54, 90, 226, 54, 51, 212, 224, 133, 25, 155, 245, 197, 32, 163, 185, 15, 237, 19, 34, 160, 52, 47, 252, 51],
    },
];

pub struct Pool {
    pub address: Pubkey,
    pub asset_a: usize,
    pub asset_b: usize,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub tick_spacing: u16,
    /// Orca oracle PDA ["oracle", pool]. Not initialized for these fixed-fee pools; Orca still
    /// requires the address in `swap`.
    pub oracle: Pubkey,
}

pub const POOLS: [Pool; 2] = [
    Pool { // cbBTC/USDC 0.04%, TVL ~5.1M USD on 2026-11-03
        address: pubkey!("HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM"),
        asset_a: 1,
        asset_b: ASSET_USDC,
        vault_a: pubkey!("FWiLr7QtETCRs3CxFTAMmLynitX8uEjw9HxpFjxKQrAe"),
        vault_b: pubkey!("5ahiXjuZgWQPqYEay5GFHv5r3ycXqgxacoeXX7VetByd"),
        tick_spacing: 4,
        oracle: pubkey!("8KEgiSnNwRvYCZbUNg9EJ7VAx2PWUKSeWShgHqbbBaMe"),
    },
    Pool { // cbBTC/WBTC 0.01%, TVL ~1.2M USD on 2026-11-03
        address: pubkey!("4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72"),
        asset_a: 1,
        asset_b: 2,
        vault_a: pubkey!("Br2L7L6Vfro799PuNH7xdQPs6bZ4DGi2DMFsUX3DdUPW"),
        vault_b: pubkey!("4WBthDFFdS8mqJ3o9hoxtaEewcn7nuXpqUnQiHhJfHVQ"),
        tick_spacing: 1,
        oracle: pubkey!("6MLfCETK3hWWKnGsJeAegi3dmW52RJB8mytQBom5PodC"),
    },
];

// ---------------------------------------------------------------- math

const LOW_64: u128 = u64::MAX as u128;

fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a1, a0) = (a >> 64, a & LOW_64);
    let (b1, b0) = (b >> 64, b & LOW_64);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & LOW_64) + (p10 & LOW_64);
    let lo = (p00 & LOW_64) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// floor(a * b / c) with a 256-bit intermediate. None on division by zero or a u128 overflow.
pub fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    let (hi, lo) = mul_wide(a, b);
    if hi == 0 {
        return Some(lo / c);
    }
    if hi >= c {
        return None;
    }
    let (mut r, mut q) = (hi, 0u128);
    for i in (0..128).rev() {
        let carry = r >> 127;
        r = (r << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || r >= c {
            r = r.wrapping_sub(c);
            q |= 1;
        }
    }
    Some(q)
}

fn pow10(exp: i32) -> Option<u128> {
    if !(0..=30).contains(&exp) {
        return None;
    }
    10u128.checked_pow(exp as u32)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Price {
    pub price: u64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
}

/// Pyth `PriceUpdateV2` with `VerificationLevel::Full` (1-byte tag, so the message starts at 41).
pub fn parse_price_update(data: &[u8], feed_id: &[u8; 32]) -> Result<Price> {
    require!(data.len() >= 101 && data[..8] == PRICE_UPDATE_V2, OrcaError::InvalidOracle);
    require!(data[40] == 1, OrcaError::InvalidOracle);
    let o = 41;
    require!(data[o..o + 32] == feed_id[..], OrcaError::InvalidOracle);
    let i64_at = |at: usize| i64::from_le_bytes(data[at..at + 8].try_into().unwrap());
    let price = i64_at(o + 32);
    let conf = u64::from_le_bytes(data[o + 40..o + 48].try_into().unwrap());
    let expo = i32::from_le_bytes(data[o + 48..o + 52].try_into().unwrap());
    let publish_time = i64_at(o + 52);
    require!(price > 0 && (-18..=0).contains(&expo), OrcaError::InvalidOracle);
    Ok(Price { price: price as u64, conf, expo, publish_time })
}

pub fn check_price(p: &Price, now: i64) -> Result<()> {
    require!(p.publish_time <= now + 30 && now - p.publish_time <= ORACLE_MAX_AGE_SECONDS, OrcaError::StaleOracle);
    require!(u128::from(p.conf) * 10_000 <= u128::from(p.price) * MAX_ORACLE_CONF_BPS, OrcaError::OracleConfidence);
    Ok(())
}

/// Raw `amount` of an asset with `from` price and decimals into raw units of `to`, at oracle prices.
pub fn convert(amount: u64, from: &Price, from_decimals: u8, to: &Price, to_decimals: u8) -> Option<u64> {
    let net = (from.expo + i32::from(to_decimals)) - (to.expo + i32::from(from_decimals));
    let numerator = u128::from(amount) * u128::from(from.price);
    let out = if net >= 0 {
        mul_div(numerator, pow10(net)?, u128::from(to.price))?
    } else {
        mul_div(numerator, 1, u128::from(to.price).checked_mul(pow10(-net)?)?)?
    };
    u64::try_from(out).ok()
}

/// Oracle price of one raw unit of A in raw units of B, as Q64.64 (Orca's price convention).
pub fn oracle_price_x64(a: &Price, a_decimals: u8, b: &Price, b_decimals: u8) -> Option<u128> {
    let net = a.expo - b.expo + i32::from(b_decimals) - i32::from(a_decimals);
    if net >= 0 {
        mul_div(u128::from(a.price).checked_mul(pow10(net)?)?, 1u128 << 64, u128::from(b.price))
    } else {
        mul_div(u128::from(a.price), 1u128 << 64, u128::from(b.price).checked_mul(pow10(-net)?)?)
    }
}

pub fn pool_price_x64(sqrt_price: u128) -> Option<u128> {
    mul_div(sqrt_price, sqrt_price, 1u128 << 64)
}

pub fn within_band(pool: u128, oracle: u128, max_bps: u16) -> bool {
    let diff = pool.abs_diff(oracle);
    match (diff.checked_mul(10_000), oracle.checked_mul(u128::from(max_bps))) {
        (Some(lhs), Some(rhs)) => lhs <= rhs,
        _ => false,
    }
}

/// Price limit for the swap: price may move at most (slippage + deviation) from the current,
/// already band-checked pool price. sqrt moves by half the price move.
pub fn sqrt_price_limit(sqrt_now: u128, a_to_b: bool, total_bps: u16) -> Option<u128> {
    let total = u128::from(total_bps);
    let limit = if a_to_b {
        mul_div(sqrt_now, 20_000u128.checked_sub(total)?, 20_000)?
    } else {
        mul_div(sqrt_now, 20_000 + total, 20_000)?
    };
    Some(limit.clamp(MIN_SQRT_PRICE, MAX_SQRT_PRICE))
}

pub fn apply_bps_floor(amount: u64, bps_off: u16) -> u64 {
    (u128::from(amount) * u128::from(10_000u16.saturating_sub(bps_off)) / 10_000) as u64
}

/// Basis released when removing `removed` of `before` liquidity. The last unit releases the rest.
pub fn basis_for_liquidity(principal: u64, before: u128, removed: u128) -> Result<u64> {
    require!(before > 0 && removed > 0 && removed <= before, OrcaError::InvalidLiquidity);
    if removed == before {
        return Ok(principal);
    }
    let out = mul_div(u128::from(principal), removed, before).ok_or(OrcaError::MathOverflow)?;
    Ok(out as u64)
}

pub fn fee_split(collected: u64, fee_bps: u16) -> u64 {
    (u128::from(collected) * u128::from(fee_bps) / 10_000) as u64
}

// ---------------------------------------------------------------- policy

#[account]
#[derive(InitSpace)]
pub struct OrcaPolicy {
    pub vault: Pubkey,
    pub bump: u8,
    /// Owner switch for every agent Orca action. Owner actions ignore it.
    pub agent_enabled: bool,
    /// Bit i enables POOLS[i] for the agent.
    pub pools_mask: u8,
    pub max_slippage_bps: u16,
    pub max_oracle_deviation_bps: u16,
    /// Agent cap on the USDC value of each non-USDC asset held idle in the Safe (index = ASSETS).
    pub max_hold_usdc: [u64; ASSET_COUNT],
    /// Agent cap on the Safe's total LP cost basis (USDC base units).
    pub max_lp_principal_usdc: u64,
    pub min_width_ticks: i32,
    pub max_width_ticks: i32,
    pub max_opens_24h: u8,
    pub opens_window_start: i64,
    pub opens_in_window: u8,
    /// Positions currently registered (owner and agent), at most MAX_ORCA_POSITIONS.
    pub open_positions: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrcaPolicyArgs {
    pub agent_enabled: bool,
    pub pools_mask: u8,
    pub max_slippage_bps: u16,
    pub max_oracle_deviation_bps: u16,
    pub max_hold_usdc: [u64; ASSET_COUNT],
    pub max_lp_principal_usdc: u64,
    pub min_width_ticks: i32,
    pub max_width_ticks: i32,
    pub max_opens_24h: u8,
}

pub fn validate_orca_policy(args: &OrcaPolicyArgs) -> Result<()> {
    require!(args.max_slippage_bps > 0 && args.max_slippage_bps <= MAX_SLIPPAGE_BPS_CAP, OrcaError::InvalidPolicy);
    require!(args.max_oracle_deviation_bps > 0 && args.max_oracle_deviation_bps <= MAX_DEVIATION_BPS_CAP, OrcaError::InvalidPolicy);
    require!(u32::from(args.pools_mask) < (1u32 << POOLS.len()), OrcaError::InvalidPolicy);
    require!(args.min_width_ticks > 0 && args.max_width_ticks >= args.min_width_ticks, OrcaError::InvalidPolicy);
    require!(args.max_opens_24h <= MAX_OPENS_PER_DAY_CAP, OrcaError::InvalidPolicy);
    Ok(())
}

/// Rolling 24-hour counter of agent position opens (each rebalance opens one position).
pub fn register_open(policy: &mut OrcaPolicy, now: i64) -> Result<()> {
    if now.saturating_sub(policy.opens_window_start) >= SECONDS_PER_DAY {
        policy.opens_window_start = now;
        policy.opens_in_window = 0;
    }
    require!(policy.opens_in_window < policy.max_opens_24h, OrcaError::RebalanceLimit);
    policy.opens_in_window += 1;
    Ok(())
}

/// Agent range rules: aligned ticks, width inside the owner's bounds, current price in range.
pub fn check_agent_range(lower: i32, upper: i32, spacing: u16, current: i32, min_w: i32, max_w: i32) -> Result<()> {
    let spacing = i32::from(spacing);
    require!(lower < upper && lower % spacing == 0 && upper % spacing == 0, OrcaError::InvalidRange);
    let width = upper.checked_sub(lower).ok_or(OrcaError::InvalidRange)?;
    require!(width >= min_w && width <= max_w, OrcaError::InvalidRange);
    require!(lower <= current && current < upper, OrcaError::InvalidRange);
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct LpFeeConfig {
    pub bump: u8,
    pub lp_fee_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct OrcaPositionRecord {
    pub vault: Pubkey,
    pub position_mint: Pubkey,
    /// Paid the position rent; receives it back on close.
    pub funder: Pubkey,
    pub pool: u8,
    pub bump: u8,
    /// LP fee rate fixed when the position was opened.
    pub fee_bps: u16,
    pub tick_lower: i32,
    pub tick_upper: i32,
    /// Oracle USDC value of tokens added, minus basis released by decreases.
    pub principal_usdc: u64,
    pub opened_at: i64,
    pub fees_collected_a: u64,
    pub fees_collected_b: u64,
    pub fees_paid_a: u64,
    pub fees_paid_b: u64,
}

// ---------------------------------------------------------------- account checks

fn pool_at(index: u8) -> Result<&'static Pool> {
    POOLS.get(usize::from(index)).ok_or_else(|| error!(OrcaError::UnknownPool))
}

fn safe_ata(vault: &Pubkey, mint: &Pubkey) -> Pubkey {
    anchor_spl::associated_token::get_associated_token_address(vault, mint)
}

fn safe_nft_ata(vault: &Pubkey, mint: &Pubkey) -> Pubkey {
    anchor_spl::associated_token::get_associated_token_address_with_program_id(vault, mint, &anchor_spl::token_2022::ID)
}

pub fn position_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position", mint.as_ref()], &ORCA_PROGRAM).0
}

/// True for an Orca Token-2022 position NFT: its MintCloseAuthority is the Orca position PDA
/// (checked against live mints on 2026-11-04).
pub fn is_orca_position_mint(mint: &AccountInfo) -> bool {
    use anchor_spl::token_2022::spl_token_2022::extension::mint_close_authority::MintCloseAuthority;
    if *mint.owner != anchor_spl::token_2022::ID {
        return false;
    }
    match anchor_spl::token_interface::get_mint_extension_data::<MintCloseAuthority>(mint) {
        Ok(ext) => Option::<Pubkey>::from(ext.close_authority) == Some(position_pda(&mint.key())),
        Err(_) => false,
    }
}

pub struct PoolState {
    pub sqrt_price: u128,
    pub tick_current: i32,
}

fn key_at(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

pub fn validate_pool_data(key: &Pubkey, owner: &Pubkey, d: &[u8], pool: &Pool) -> Result<PoolState> {
    require_keys_eq!(*key, pool.address, OrcaError::UnknownPool);
    require_keys_eq!(*owner, ORCA_PROGRAM, OrcaError::InvalidPoolState);
    require!(d.len() >= 261 && d[..8] == WHIRLPOOL_DISCRIMINATOR, OrcaError::InvalidPoolState);
    require!(u16::from_le_bytes([d[41], d[42]]) == pool.tick_spacing, OrcaError::InvalidPoolState);
    require_keys_eq!(key_at(d, 101), ASSETS[pool.asset_a].mint, OrcaError::InvalidPoolState);
    require_keys_eq!(key_at(d, 133), pool.vault_a, OrcaError::InvalidPoolState);
    require_keys_eq!(key_at(d, 181), ASSETS[pool.asset_b].mint, OrcaError::InvalidPoolState);
    require_keys_eq!(key_at(d, 213), pool.vault_b, OrcaError::InvalidPoolState);
    Ok(PoolState {
        sqrt_price: u128::from_le_bytes(d[65..81].try_into().unwrap()),
        tick_current: i32::from_le_bytes(d[81..85].try_into().unwrap()),
    })
}

fn validate_pool(info: &AccountInfo, pool: &Pool) -> Result<PoolState> {
    let data = info.try_borrow_data()?;
    validate_pool_data(&info.key(), info.owner, &data, pool)
}

pub struct PositionState {
    pub liquidity: u128,
    pub fee_owed_a: u64,
    pub fee_owed_b: u64,
}

pub fn validate_position_data(d: &[u8], pool: &Pool, mint: &Pubkey) -> Result<PositionState> {
    require!(d.len() >= 144 && d[..8] == POSITION_DISCRIMINATOR, OrcaError::InvalidPosition);
    require_keys_eq!(key_at(d, 8), pool.address, OrcaError::InvalidPosition);
    require_keys_eq!(key_at(d, 40), *mint, OrcaError::InvalidPosition);
    Ok(PositionState {
        liquidity: u128::from_le_bytes(d[72..88].try_into().unwrap()),
        fee_owed_a: u64::from_le_bytes(d[112..120].try_into().unwrap()),
        fee_owed_b: u64::from_le_bytes(d[136..144].try_into().unwrap()),
    })
}

fn validate_position(info: &AccountInfo, pool: &Pool, mint: &Pubkey) -> Result<PositionState> {
    require_keys_eq!(info.key(), position_pda(mint), OrcaError::InvalidPosition);
    require_keys_eq!(*info.owner, ORCA_PROGRAM, OrcaError::InvalidPosition);
    let data = info.try_borrow_data()?;
    validate_position_data(&data, pool, mint)
}

fn require_orca_owned(infos: &[&AccountInfo]) -> Result<()> {
    for info in infos {
        require_keys_eq!(*info.owner, ORCA_PROGRAM, OrcaError::InvalidTickArray);
    }
    Ok(())
}

fn load_price(info: &AccountInfo, asset: usize, now: i64) -> Result<Price> {
    require_keys_eq!(info.key(), ASSETS[asset].feed, OrcaError::InvalidOracle);
    require_keys_eq!(*info.owner, PYTH_RECEIVER, OrcaError::InvalidOracle);
    let price = parse_price_update(&info.try_borrow_data()?, &ASSETS[asset].feed_id)?;
    check_price(&price, now)?;
    Ok(price)
}

/// Prices for both pool assets and USDC, and the pool-vs-oracle band check.
struct Quotes {
    a: Price,
    b: Price,
    usdc: Price,
}

fn load_quotes(pool: &Pool, feeds: [&AccountInfo; 3], state: &PoolState, max_dev_bps: u16, now: i64) -> Result<Quotes> {
    let a = load_price(feeds[0], pool.asset_a, now)?;
    let b = load_price(feeds[1], pool.asset_b, now)?;
    let usdc = load_price(feeds[2], ASSET_USDC, now)?;
    let oracle = oracle_price_x64(&a, ASSETS[pool.asset_a].decimals, &b, ASSETS[pool.asset_b].decimals)
        .ok_or(OrcaError::MathOverflow)?;
    let spot = pool_price_x64(state.sqrt_price).ok_or(OrcaError::MathOverflow)?;
    require!(within_band(spot, oracle, max_dev_bps), OrcaError::PriceOutOfBand);
    Ok(Quotes { a, b, usdc })
}

fn usdc_value(amount: u64, asset: usize, price: &Price, usdc: &Price) -> Result<u64> {
    if asset == ASSET_USDC {
        return Ok(amount);
    }
    convert(amount, price, ASSETS[asset].decimals, usdc, ASSETS[ASSET_USDC].decimals)
        .ok_or_else(|| error!(OrcaError::MathOverflow))
}

/// Owner or registered agent; the agent also needs the owner's Orca switch.
fn orca_actor(vault: &Vault, authority: &Pubkey, registry: &ExecutorRegistry, policy: &OrcaPolicy) -> Result<bool> {
    require_owner_or_agent(vault, authority, registry)?;
    let executor = *authority != vault.owner;
    if executor {
        require!(policy.agent_enabled, OrcaError::AgentDisabled);
    }
    Ok(executor)
}

fn meta(info: &AccountInfo, writable: bool, signer: bool) -> AccountMeta {
    if writable { AccountMeta::new(info.key(), signer) } else { AccountMeta::new_readonly(info.key(), signer) }
}

fn invoke_orca<'info>(vault: &Account<'info, Vault>, data: Vec<u8>, metas: Vec<AccountMeta>, infos: &[AccountInfo<'info>]) -> Result<()> {
    let ix = Instruction { program_id: ORCA_PROGRAM, accounts: metas, data };
    let bump = [vault.bump];
    let seeds: &[&[u8]] = &[b"vault", vault.owner.as_ref(), &bump];
    invoke_signed(&ix, infos, &[seeds])?;
    Ok(())
}

/// Same steps as Anchor's `close`: move all lamports, hand the account to the System Program,
/// drop its data. Used where the record is optional and loaded by hand.
fn close_program_account<'info>(info: &AccountInfo<'info>, destination: &AccountInfo<'info>) -> Result<()> {
    let lamports = info.lamports();
    destination.add_lamports(lamports)?;
    info.sub_lamports(lamports)?;
    info.assign(&anchor_lang::system_program::ID);
    info.resize(0)?;
    Ok(())
}

fn token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    Ok(TokenAccount::try_deserialize(&mut &data[..])?.amount)
}

// ---------------------------------------------------------------- admin and owner setup

#[derive(Accounts)]
pub struct InitLpFeeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + LpFeeConfig::INIT_SPACE, seeds = [b"lp_fee_config"], bump)]
    pub lp_fee_config: Account<'info, LpFeeConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetLpFee<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"lp_fee_config"], bump = lp_fee_config.bump)]
    pub lp_fee_config: Account<'info, LpFeeConfig>,
}

pub fn handle_init_lp_fee_config(ctx: Context<InitLpFeeConfig>) -> Result<()> {
    ctx.accounts.lp_fee_config.bump = ctx.bumps.lp_fee_config;
    ctx.accounts.lp_fee_config.lp_fee_bps = DEFAULT_LP_FEE_BPS;
    Ok(())
}

/// Applies to positions opened afterwards; open positions keep their snapshotted rate.
pub fn handle_set_lp_fee(ctx: Context<SetLpFee>, lp_fee_bps: u16) -> Result<()> {
    require!(lp_fee_bps <= MAX_LP_FEE_BPS, ErrorCode::FeeTooHigh);
    ctx.accounts.lp_fee_config.lp_fee_bps = lp_fee_bps;
    Ok(())
}

#[derive(Accounts)]
pub struct SetOrcaPolicy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(init_if_needed, payer = owner, space = 8 + OrcaPolicy::INIT_SPACE,
        seeds = [b"orca_policy", vault.key().as_ref()], bump)]
    pub orca_policy: Account<'info, OrcaPolicy>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_orca_policy(ctx: Context<SetOrcaPolicy>, args: OrcaPolicyArgs) -> Result<()> {
    validate_orca_policy(&args)?;
    let vault_key = ctx.accounts.vault.key();
    let p = &mut ctx.accounts.orca_policy;
    if p.vault == Pubkey::default() {
        p.vault = vault_key;
        p.bump = ctx.bumps.orca_policy;
    }
    require_keys_eq!(p.vault, vault_key, OrcaError::InvalidPolicy);
    p.agent_enabled = args.agent_enabled;
    p.pools_mask = args.pools_mask;
    p.max_slippage_bps = args.max_slippage_bps;
    p.max_oracle_deviation_bps = args.max_oracle_deviation_bps;
    p.max_hold_usdc = args.max_hold_usdc;
    p.max_lp_principal_usdc = args.max_lp_principal_usdc;
    p.min_width_ticks = args.min_width_ticks;
    p.max_width_ticks = args.max_width_ticks;
    p.max_opens_24h = args.max_opens_24h;
    // Counters (opens_in_window, open_positions) are never reset by a policy change.
    Ok(())
}

// ---------------------------------------------------------------- swap

#[derive(Accounts)]
pub struct OrcaSwap<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Box<Account<'info, ExecutorRegistry>>,
    #[account(mut, seeds = [b"executor_limits", vault.key().as_ref()], bump = executor_limits.bump,
        constraint = executor_limits.vault == vault.key() @ ErrorCode::InvalidExecutorLimits)]
    pub executor_limits: Box<Account<'info, ExecutorLimits>>,
    #[account(seeds = [b"orca_policy", vault.key().as_ref()], bump = orca_policy.bump,
        constraint = orca_policy.vault == vault.key() @ OrcaError::InvalidPolicy)]
    pub orca_policy: Box<Account<'info, OrcaPolicy>>,
    /// CHECK: pinned pool; address, owner and layout validated in the handler.
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault)]
    pub safe_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = vault)]
    pub safe_token_b: Box<Account<'info, TokenAccount>>,
    /// CHECK: must equal the pinned pool vault A.
    #[account(mut)]
    pub token_vault_a: UncheckedAccount<'info>,
    /// CHECK: must equal the pinned pool vault B.
    #[account(mut)]
    pub token_vault_b: UncheckedAccount<'info>,
    /// CHECK: Orca-owned; Orca validates sequence and pool binding.
    #[account(mut)]
    pub tick_array_0: UncheckedAccount<'info>,
    /// CHECK: Orca-owned; Orca validates sequence and pool binding.
    #[account(mut)]
    pub tick_array_1: UncheckedAccount<'info>,
    /// CHECK: Orca-owned; Orca validates sequence and pool binding.
    #[account(mut)]
    pub tick_array_2: UncheckedAccount<'info>,
    /// CHECK: must equal the pinned Orca oracle PDA of the pool.
    #[account(mut)]
    pub orca_oracle: UncheckedAccount<'info>,
    /// CHECK: pinned Pyth feed of pool asset A.
    pub feed_a: UncheckedAccount<'info>,
    /// CHECK: pinned Pyth feed of pool asset B.
    pub feed_b: UncheckedAccount<'info>,
    /// CHECK: pinned Pyth USDC/USD feed.
    pub feed_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = ORCA_PROGRAM)]
    pub orca_program: UncheckedAccount<'info>,
}

#[event]
pub struct OrcaSwapEvent {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub a_to_b: bool,
    pub spent: u64,
    pub received: u64,
    pub value_usdc: u64,
    pub executor: bool,
}

/// Exact-input swap on a pinned pool. Owner or agent. Input and output stay in the Safe's ATAs.
pub fn handle_orca_swap<'info>(ctx: Context<'_, '_, '_, 'info, OrcaSwap<'info>>, pool_index: u8, a_to_b: bool, amount_in: u64, min_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = pool_at(pool_index)?;
    let a = &ctx.accounts;
    let executor = orca_actor(&a.vault, &a.authority.key(), &a.executor_registry, &a.orca_policy)?;
    if executor {
        require!(a.orca_policy.pools_mask & (1 << pool_index) != 0, OrcaError::PoolDisabled);
    }
    require!(amount_in > 0 && min_out > 0, ErrorCode::ZeroAmount);
    let state = validate_pool(&a.whirlpool, pool)?;
    let vault_key = a.vault.key();
    require_keys_eq!(a.safe_token_a.key(), safe_ata(&vault_key, &ASSETS[pool.asset_a].mint), OrcaError::InvalidSafeAccount);
    require_keys_eq!(a.safe_token_b.key(), safe_ata(&vault_key, &ASSETS[pool.asset_b].mint), OrcaError::InvalidSafeAccount);
    require_keys_eq!(a.token_vault_a.key(), pool.vault_a, OrcaError::InvalidPoolState);
    require_keys_eq!(a.token_vault_b.key(), pool.vault_b, OrcaError::InvalidPoolState);
    require_keys_eq!(a.orca_oracle.key(), pool.oracle, OrcaError::InvalidPoolState);
    require_orca_owned(&[&a.tick_array_0, &a.tick_array_1, &a.tick_array_2])?;

    let policy = &a.orca_policy;
    let q = load_quotes(pool, [&a.feed_a, &a.feed_b, &a.feed_usdc], &state, policy.max_oracle_deviation_bps, now)?;
    let (in_asset, out_asset, in_price, out_price) =
        if a_to_b { (pool.asset_a, pool.asset_b, q.a, q.b) } else { (pool.asset_b, pool.asset_a, q.b, q.a) };
    let expected = convert(amount_in, &in_price, ASSETS[in_asset].decimals, &out_price, ASSETS[out_asset].decimals)
        .ok_or(OrcaError::MathOverflow)?;
    // The floor comes from Pyth, never from the caller's quote. Callers may only be stricter.
    require!(min_out >= apply_bps_floor(expected, policy.max_slippage_bps), OrcaError::Slippage);
    let limit = sqrt_price_limit(state.sqrt_price, a_to_b,
        policy.max_slippage_bps + policy.max_oracle_deviation_bps).ok_or(OrcaError::MathOverflow)?;

    let (in_before, out_before) = if a_to_b { (a.safe_token_a.amount, a.safe_token_b.amount) } else { (a.safe_token_b.amount, a.safe_token_a.amount) };
    let mut data = IX_SWAP.to_vec();
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    data.extend_from_slice(&limit.to_le_bytes());
    data.push(1); // amount_specified_is_input
    data.push(u8::from(a_to_b));
    let vault_info = a.vault.to_account_info();
    let metas = vec![
        meta(&a.token_program, false, false), meta(&vault_info, false, true),
        meta(&a.whirlpool, true, false), meta(&a.safe_token_a.to_account_info(), true, false),
        meta(&a.token_vault_a, true, false), meta(&a.safe_token_b.to_account_info(), true, false),
        meta(&a.token_vault_b, true, false), meta(&a.tick_array_0, true, false),
        meta(&a.tick_array_1, true, false), meta(&a.tick_array_2, true, false),
        meta(&a.orca_oracle, true, false),
    ];
    let infos = [
        a.token_program.to_account_info(), vault_info, a.whirlpool.to_account_info(),
        a.safe_token_a.to_account_info(), a.token_vault_a.to_account_info(),
        a.safe_token_b.to_account_info(), a.token_vault_b.to_account_info(),
        a.tick_array_0.to_account_info(), a.tick_array_1.to_account_info(),
        a.tick_array_2.to_account_info(), a.orca_oracle.to_account_info(),
        a.orca_program.to_account_info(),
    ];
    invoke_orca(&a.vault, data, metas, &infos)?;

    ctx.accounts.safe_token_a.reload()?;
    ctx.accounts.safe_token_b.reload()?;
    let a = &ctx.accounts;
    let (in_after, out_after) = if a_to_b { (a.safe_token_a.amount, a.safe_token_b.amount) } else { (a.safe_token_b.amount, a.safe_token_a.amount) };
    let spent = in_before.checked_sub(in_after).ok_or(OrcaError::BalanceDelta)?;
    let received = out_after.checked_sub(out_before).ok_or(OrcaError::BalanceDelta)?;
    require!(spent > 0 && spent <= amount_in && received >= min_out, OrcaError::BalanceDelta);
    let value = usdc_value(spent, in_asset, &in_price, &q.usdc)?;
    if executor && out_asset != ASSET_USDC {
        let held = usdc_value(out_after, out_asset, &out_price, &q.usdc)?;
        require!(held <= a.orca_policy.max_hold_usdc[out_asset], OrcaError::HoldLimit);
    }
    let authority = a.authority.key();
    charge_executor_volume(&ctx.accounts.vault, &authority, Some(&mut ctx.accounts.executor_limits), value, None, now)?;
    ctx.accounts.vault.last_rebalance_ts = now;
    emit!(OrcaSwapEvent { vault: vault_key, pool: pool.address, a_to_b, spent, received, value_usdc: value, executor });
    Ok(())
}

// ---------------------------------------------------------------- LP: open

#[derive(Accounts)]
pub struct OrcaOpenPosition<'info> {
    /// Owner or agent; pays rent for the Orca position and the record.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Box<Account<'info, ExecutorRegistry>>,
    #[account(mut, seeds = [b"orca_policy", vault.key().as_ref()], bump = orca_policy.bump,
        constraint = orca_policy.vault == vault.key() @ OrcaError::InvalidPolicy)]
    pub orca_policy: Box<Account<'info, OrcaPolicy>>,
    #[account(seeds = [b"lp_fee_config"], bump = lp_fee_config.bump)]
    pub lp_fee_config: Box<Account<'info, LpFeeConfig>>,
    /// CHECK: pinned pool; validated in the handler.
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: Orca position PDA ["position", position_mint]; Orca initializes it.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// Fresh keypair for the position NFT mint.
    #[account(mut)]
    pub position_mint: Signer<'info>,
    /// CHECK: Safe's Token-2022 ATA for the NFT; Orca creates it.
    #[account(mut)]
    pub position_token_account: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + OrcaPositionRecord::INIT_SPACE,
        seeds = [b"orca_position", vault.key().as_ref(), position_mint.key().as_ref()], bump)]
    pub position_record: Box<Account<'info, OrcaPositionRecord>>,
    /// CHECK: pinned Pyth feed of pool asset A.
    pub feed_a: UncheckedAccount<'info>,
    /// CHECK: pinned Pyth feed of pool asset B.
    pub feed_b: UncheckedAccount<'info>,
    /// CHECK: pinned Pyth USDC/USD feed.
    pub feed_usdc: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: Orca's fixed metadata update authority.
    #[account(address = ORCA_METADATA_UPDATE_AUTH)]
    pub metadata_update_auth: UncheckedAccount<'info>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = ORCA_PROGRAM)]
    pub orca_program: UncheckedAccount<'info>,
}

pub fn handle_orca_open<'info>(ctx: Context<'_, '_, '_, 'info, OrcaOpenPosition<'info>>, pool_index: u8, tick_lower: i32, tick_upper: i32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = pool_at(pool_index)?;
    let a = &ctx.accounts;
    let executor = orca_actor(&a.vault, &a.authority.key(), &a.executor_registry, &a.orca_policy)?;
    require!(a.orca_policy.open_positions < MAX_ORCA_POSITIONS, OrcaError::TooManyPositions);
    require!(tick_lower < tick_upper, OrcaError::InvalidRange);
    let state = validate_pool(&a.whirlpool, pool)?;
    let vault_key = a.vault.key();
    let mint = a.position_mint.key();
    require_keys_eq!(a.position.key(), position_pda(&mint), OrcaError::InvalidPosition);
    require_keys_eq!(a.position_token_account.key(), safe_nft_ata(&vault_key, &mint), OrcaError::InvalidSafeAccount);
    if executor {
        let policy = &a.orca_policy;
        require!(policy.pools_mask & (1 << pool_index) != 0, OrcaError::PoolDisabled);
        require!(a.vault.allocation_bps[ROUTE_ORCA_LP] > 0, ErrorCode::RouteDisabled);
        load_quotes(pool, [&a.feed_a, &a.feed_b, &a.feed_usdc], &state, policy.max_oracle_deviation_bps, now)?;
        check_agent_range(tick_lower, tick_upper, pool.tick_spacing, state.tick_current,
            policy.min_width_ticks, policy.max_width_ticks)?;
    }

    let mut data = IX_OPEN_POSITION_WITH_TOKEN_EXTENSIONS.to_vec();
    data.extend_from_slice(&tick_lower.to_le_bytes());
    data.extend_from_slice(&tick_upper.to_le_bytes());
    data.push(0); // with_token_metadata_extension = false
    let vault_info = a.vault.to_account_info();
    let metas = vec![
        meta(&a.authority, true, true), meta(&vault_info, false, false),
        meta(&a.position, true, false), meta(&a.position_mint, true, true),
        meta(&a.position_token_account, true, false), meta(&a.whirlpool, false, false),
        meta(&a.token_2022_program, false, false), meta(&a.system_program, false, false),
        meta(&a.associated_token_program, false, false), meta(&a.metadata_update_auth, false, false),
    ];
    let infos = [
        a.authority.to_account_info(), vault_info, a.position.to_account_info(),
        a.position_mint.to_account_info(), a.position_token_account.to_account_info(),
        a.whirlpool.to_account_info(), a.token_2022_program.to_account_info(),
        a.system_program.to_account_info(), a.associated_token_program.to_account_info(),
        a.metadata_update_auth.to_account_info(), a.orca_program.to_account_info(),
    ];
    invoke_orca(&a.vault, data, metas, &infos)?;

    let fee_bps = ctx.accounts.lp_fee_config.lp_fee_bps;
    require!(fee_bps <= MAX_LP_FEE_BPS, ErrorCode::FeeTooHigh);
    let authority = ctx.accounts.authority.key();
    if executor {
        register_open(&mut ctx.accounts.orca_policy, now)?;
    }
    ctx.accounts.orca_policy.open_positions += 1;
    let r = &mut ctx.accounts.position_record;
    r.vault = vault_key;
    r.position_mint = mint;
    r.funder = authority;
    r.pool = pool_index;
    r.bump = ctx.bumps.position_record;
    r.fee_bps = fee_bps;
    r.tick_lower = tick_lower;
    r.tick_upper = tick_upper;
    r.opened_at = now;
    Ok(())
}

// ---------------------------------------------------------------- LP: increase / decrease

#[derive(Accounts)]
pub struct OrcaLiquidity<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Box<Account<'info, ExecutorRegistry>>,
    #[account(mut, seeds = [b"executor_limits", vault.key().as_ref()], bump = executor_limits.bump,
        constraint = executor_limits.vault == vault.key() @ ErrorCode::InvalidExecutorLimits)]
    pub executor_limits: Box<Account<'info, ExecutorLimits>>,
    #[account(seeds = [b"orca_policy", vault.key().as_ref()], bump = orca_policy.bump,
        constraint = orca_policy.vault == vault.key() @ OrcaError::InvalidPolicy)]
    pub orca_policy: Box<Account<'info, OrcaPolicy>>,
    #[account(mut, seeds = [b"orca_position", vault.key().as_ref(), position_record.position_mint.as_ref()],
        bump = position_record.bump, constraint = position_record.vault == vault.key() @ OrcaError::InvalidPosition)]
    pub position_record: Box<Account<'info, OrcaPositionRecord>>,
    /// CHECK: pinned pool of the record; validated in the handler.
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: Orca position PDA of the record's mint; validated in the handler.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: Safe's Token-2022 NFT ATA; validated in the handler.
    pub position_token_account: UncheckedAccount<'info>,
    /// CHECK: pinned mint A.
    pub token_mint_a: UncheckedAccount<'info>,
    /// CHECK: pinned mint B.
    pub token_mint_b: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault)]
    pub safe_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = vault)]
    pub safe_token_b: Box<Account<'info, TokenAccount>>,
    /// CHECK: pinned pool vault A.
    #[account(mut)]
    pub token_vault_a: UncheckedAccount<'info>,
    /// CHECK: pinned pool vault B.
    #[account(mut)]
    pub token_vault_b: UncheckedAccount<'info>,
    /// CHECK: Orca-owned; Orca checks it covers tick_lower.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: Orca-owned; Orca checks it covers tick_upper.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    /// CHECK: pinned Pyth feed of pool asset A.
    pub feed_a: UncheckedAccount<'info>,
    /// CHECK: pinned Pyth feed of pool asset B.
    pub feed_b: UncheckedAccount<'info>,
    /// CHECK: pinned Pyth USDC/USD feed.
    pub feed_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: SPL Memo, required by Orca v2 instructions.
    #[account(address = MEMO_PROGRAM)]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = ORCA_PROGRAM)]
    pub orca_program: UncheckedAccount<'info>,
}

#[event]
pub struct OrcaLiquidityEvent {
    pub vault: Pubkey,
    pub position_mint: Pubkey,
    pub increase: bool,
    pub liquidity: u128,
    pub amount_a: u64,
    pub amount_b: u64,
    pub value_usdc: u64,
    pub basis_usdc: u64,
    pub executor: bool,
}

/// Shared validation for increase/decrease. Returns (pool, position state).
fn check_liquidity_accounts(a: &OrcaLiquidity) -> Result<(&'static Pool, PoolState, PositionState)> {
    let pool = pool_at(a.position_record.pool)?;
    let state = validate_pool(&a.whirlpool, pool)?;
    let mint = a.position_record.position_mint;
    let position = validate_position(&a.position, pool, &mint)?;
    let vault_key = a.vault.key();
    require_keys_eq!(a.position_token_account.key(), safe_nft_ata(&vault_key, &mint), OrcaError::InvalidSafeAccount);
    require_keys_eq!(a.token_mint_a.key(), ASSETS[pool.asset_a].mint, OrcaError::InvalidPoolState);
    require_keys_eq!(a.token_mint_b.key(), ASSETS[pool.asset_b].mint, OrcaError::InvalidPoolState);
    require_keys_eq!(a.safe_token_a.key(), safe_ata(&vault_key, &ASSETS[pool.asset_a].mint), OrcaError::InvalidSafeAccount);
    require_keys_eq!(a.safe_token_b.key(), safe_ata(&vault_key, &ASSETS[pool.asset_b].mint), OrcaError::InvalidSafeAccount);
    require_keys_eq!(a.token_vault_a.key(), pool.vault_a, OrcaError::InvalidPoolState);
    require_keys_eq!(a.token_vault_b.key(), pool.vault_b, OrcaError::InvalidPoolState);
    require_orca_owned(&[&a.tick_array_lower, &a.tick_array_upper])?;
    Ok((pool, state, position))
}

fn liquidity_cpi<'info>(a: &OrcaLiquidity<'info>, discriminator: [u8; 8], liquidity: u128, limit_a: u64, limit_b: u64) -> Result<()> {
    let mut data = discriminator.to_vec();
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&limit_a.to_le_bytes());
    data.extend_from_slice(&limit_b.to_le_bytes());
    data.push(0); // remaining_accounts_info = None
    let vault_info = a.vault.to_account_info();
    let metas = vec![
        meta(&a.whirlpool, true, false), meta(&a.token_program, false, false),
        meta(&a.token_program, false, false), meta(&a.memo_program, false, false),
        meta(&vault_info, false, true), meta(&a.position, true, false),
        meta(&a.position_token_account, false, false), meta(&a.token_mint_a, false, false),
        meta(&a.token_mint_b, false, false), meta(&a.safe_token_a.to_account_info(), true, false),
        meta(&a.safe_token_b.to_account_info(), true, false), meta(&a.token_vault_a, true, false),
        meta(&a.token_vault_b, true, false), meta(&a.tick_array_lower, true, false),
        meta(&a.tick_array_upper, true, false),
    ];
    let infos = [
        a.whirlpool.to_account_info(), a.token_program.to_account_info(), a.memo_program.to_account_info(),
        vault_info, a.position.to_account_info(), a.position_token_account.to_account_info(),
        a.token_mint_a.to_account_info(), a.token_mint_b.to_account_info(),
        a.safe_token_a.to_account_info(), a.safe_token_b.to_account_info(),
        a.token_vault_a.to_account_info(), a.token_vault_b.to_account_info(),
        a.tick_array_lower.to_account_info(), a.tick_array_upper.to_account_info(),
        a.orca_program.to_account_info(),
    ];
    invoke_orca(&a.vault, data, metas, &infos)
}

/// Add liquidity from the Safe's ATAs. The pool price must be inside the oracle band for owner
/// and agent alike: adding at a manipulated price is an immediate loss.
pub fn handle_orca_increase<'info>(ctx: Context<'_, '_, '_, 'info, OrcaLiquidity<'info>>, liquidity: u128, token_max_a: u64, token_max_b: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let executor = orca_actor(&a.vault, &a.authority.key(), &a.executor_registry, &a.orca_policy)?;
    require!(liquidity > 0, OrcaError::InvalidLiquidity);
    let (pool, state, _) = check_liquidity_accounts(a)?;
    if executor {
        require!(a.orca_policy.pools_mask & (1 << a.position_record.pool) != 0, OrcaError::PoolDisabled);
        require!(a.vault.allocation_bps[ROUTE_ORCA_LP] > 0, ErrorCode::RouteDisabled);
    }
    let q = load_quotes(pool, [&a.feed_a, &a.feed_b, &a.feed_usdc], &state, a.orca_policy.max_oracle_deviation_bps, now)?;
    let (before_a, before_b) = (a.safe_token_a.amount, a.safe_token_b.amount);
    liquidity_cpi(a, IX_INCREASE_LIQUIDITY_V2, liquidity, token_max_a, token_max_b)?;
    ctx.accounts.safe_token_a.reload()?;
    ctx.accounts.safe_token_b.reload()?;
    let a = &ctx.accounts;
    let spent_a = before_a.checked_sub(a.safe_token_a.amount).ok_or(OrcaError::BalanceDelta)?;
    let spent_b = before_b.checked_sub(a.safe_token_b.amount).ok_or(OrcaError::BalanceDelta)?;
    require!(spent_a <= token_max_a && spent_b <= token_max_b, OrcaError::BalanceDelta);
    let value = usdc_value(spent_a, pool.asset_a, &q.a, &q.usdc)?
        .checked_add(usdc_value(spent_b, pool.asset_b, &q.b, &q.usdc)?).ok_or(OrcaError::MathOverflow)?;
    require!(value > 0, ErrorCode::ZeroAmount);
    let route_after = a.vault.route_principal[ROUTE_ORCA_LP].checked_add(value).ok_or(OrcaError::MathOverflow)?;
    if executor {
        require!(route_after <= a.orca_policy.max_lp_principal_usdc, ErrorCode::ExecutorPositionLimit);
    }
    let total = total_principal_after(&a.vault, ROUTE_ORCA_LP, route_after);
    let authority = a.authority.key();
    charge_executor_volume(&ctx.accounts.vault, &authority, Some(&mut ctx.accounts.executor_limits), value, Some(total), now)?;
    let r = &mut ctx.accounts.position_record;
    r.principal_usdc = r.principal_usdc.checked_add(value).ok_or(OrcaError::MathOverflow)?;
    let mint = r.position_mint;
    ctx.accounts.vault.route_principal[ROUTE_ORCA_LP] = route_after;
    ctx.accounts.vault.last_rebalance_ts = now;
    emit!(OrcaLiquidityEvent { vault: ctx.accounts.vault.key(), position_mint: mint, increase: true, liquidity,
        amount_a: spent_a, amount_b: spent_b, value_usdc: value, basis_usdc: value, executor });
    Ok(())
}

/// Remove liquidity into the Safe's ATAs. The owner can always exit (no oracle needed);
/// the agent needs a fresh oracle and the pool inside the band.
pub fn handle_orca_decrease<'info>(ctx: Context<'_, '_, '_, 'info, OrcaLiquidity<'info>>, liquidity: u128, token_min_a: u64, token_min_b: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let executor = orca_actor(&a.vault, &a.authority.key(), &a.executor_registry, &a.orca_policy)?;
    let (pool, state, position) = check_liquidity_accounts(a)?;
    require!(liquidity > 0 && liquidity <= position.liquidity, OrcaError::InvalidLiquidity);
    let quotes = if executor {
        Some(load_quotes(pool, [&a.feed_a, &a.feed_b, &a.feed_usdc], &state, a.orca_policy.max_oracle_deviation_bps, now)?)
    } else {
        None
    };
    let (before_a, before_b) = (a.safe_token_a.amount, a.safe_token_b.amount);
    liquidity_cpi(a, IX_DECREASE_LIQUIDITY_V2, liquidity, token_min_a, token_min_b)?;
    ctx.accounts.safe_token_a.reload()?;
    ctx.accounts.safe_token_b.reload()?;
    let a = &ctx.accounts;
    let got_a = a.safe_token_a.amount.checked_sub(before_a).ok_or(OrcaError::BalanceDelta)?;
    let got_b = a.safe_token_b.amount.checked_sub(before_b).ok_or(OrcaError::BalanceDelta)?;
    require!(got_a >= token_min_a && got_b >= token_min_b, OrcaError::BalanceDelta);
    let basis = basis_for_liquidity(a.position_record.principal_usdc, position.liquidity, liquidity)?;
    let authority = a.authority.key();
    let mut value = 0;
    if let Some(q) = quotes {
        value = usdc_value(got_a, pool.asset_a, &q.a, &q.usdc)?
            .checked_add(usdc_value(got_b, pool.asset_b, &q.b, &q.usdc)?).ok_or(OrcaError::MathOverflow)?;
        // A loss must not shrink the volume budget, as on the Exponent route.
        charge_executor_volume(&ctx.accounts.vault, &authority, Some(&mut ctx.accounts.executor_limits), value.max(basis), None, now)?;
    }
    let r = &mut ctx.accounts.position_record;
    r.principal_usdc -= basis;
    let mint = r.position_mint;
    let vault = &mut ctx.accounts.vault;
    vault.route_principal[ROUTE_ORCA_LP] = vault.route_principal[ROUTE_ORCA_LP].saturating_sub(basis);
    vault.last_rebalance_ts = now;
    emit!(OrcaLiquidityEvent { vault: vault.key(), position_mint: mint, increase: false, liquidity,
        amount_a: got_a, amount_b: got_b, value_usdc: value, basis_usdc: basis, executor });
    Ok(())
}

// ---------------------------------------------------------------- LP: collect fees

#[derive(Accounts)]
pub struct OrcaCollect<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Box<Account<'info, ExecutorRegistry>>,
    #[account(seeds = [b"orca_policy", vault.key().as_ref()], bump = orca_policy.bump,
        constraint = orca_policy.vault == vault.key() @ OrcaError::InvalidPolicy)]
    pub orca_policy: Box<Account<'info, OrcaPolicy>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"orca_position", vault.key().as_ref(), position_record.position_mint.as_ref()],
        bump = position_record.bump, constraint = position_record.vault == vault.key() @ OrcaError::InvalidPosition)]
    pub position_record: Box<Account<'info, OrcaPositionRecord>>,
    /// CHECK: pinned pool of the record.
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: Orca position PDA of the record's mint.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: Safe's Token-2022 NFT ATA.
    pub position_token_account: UncheckedAccount<'info>,
    /// CHECK: Orca-owned; used to refresh fees owed.
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: Orca-owned; used to refresh fees owed.
    pub tick_array_upper: UncheckedAccount<'info>,
    /// CHECK: pinned mint A.
    pub token_mint_a: UncheckedAccount<'info>,
    /// CHECK: pinned mint B.
    pub token_mint_b: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault)]
    pub safe_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = vault)]
    pub safe_token_b: Box<Account<'info, TokenAccount>>,
    /// CHECK: pinned pool vault A.
    #[account(mut)]
    pub token_vault_a: UncheckedAccount<'info>,
    /// CHECK: pinned pool vault B.
    #[account(mut)]
    pub token_vault_b: UncheckedAccount<'info>,
    /// CHECK: ATA(config.treasury, mint A); checked when a fee is due.
    #[account(mut)]
    pub treasury_token_a: UncheckedAccount<'info>,
    /// CHECK: ATA(config.treasury, mint B); checked when a fee is due.
    #[account(mut)]
    pub treasury_token_b: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: SPL Memo.
    #[account(address = MEMO_PROGRAM)]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = ORCA_PROGRAM)]
    pub orca_program: UncheckedAccount<'info>,
}

#[event]
pub struct OrcaCollectEvent {
    pub vault: Pubkey,
    pub position_mint: Pubkey,
    pub collected_a: u64,
    pub collected_b: u64,
    pub fee_a: u64,
    pub fee_b: u64,
    pub fee_bps: u16,
}

fn update_fees<'info>(vault: &Account<'info, Vault>, whirlpool: &AccountInfo<'info>, position: &AccountInfo<'info>,
    lower: &AccountInfo<'info>, upper: &AccountInfo<'info>, orca: &AccountInfo<'info>) -> Result<()> {
    let metas = vec![meta(whirlpool, true, false), meta(position, true, false), meta(lower, false, false), meta(upper, false, false)];
    let infos = [whirlpool.clone(), position.clone(), lower.clone(), upper.clone(), orca.clone()];
    invoke_orca(vault, IX_UPDATE_FEES_AND_REWARDS.to_vec(), metas, &infos)
}

fn pay_fee<'info>(a: &OrcaCollect<'info>, from: AccountInfo<'info>, treasury: &AccountInfo<'info>, mint: &Pubkey, fee: u64) -> Result<()> {
    if fee == 0 {
        return Ok(());
    }
    require_keys_eq!(treasury.key(), safe_ata(&a.config.treasury, mint), ErrorCode::InvalidTreasury);
    require_keys_eq!(*treasury.owner, anchor_spl::token::ID, ErrorCode::InvalidTreasury);
    let bump = [a.vault.bump];
    let seeds: &[&[u8]] = &[b"vault", a.vault.owner.as_ref(), &bump];
    token::transfer(CpiContext::new_with_signer(a.token_program.to_account_info(),
        Transfer { from, to: treasury.clone(), authority: a.vault.to_account_info() }, &[seeds]), fee)
}

/// Collect trading fees into the Safe and pay the snapshotted LP fee share to the treasury.
/// Owner or agent. Rewards are not collected: the pinned pools have no active emissions.
pub fn handle_orca_collect<'info>(ctx: Context<'_, '_, '_, 'info, OrcaCollect<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    orca_actor(&a.vault, &a.authority.key(), &a.executor_registry, &a.orca_policy)?;
    let pool = pool_at(a.position_record.pool)?;
    validate_pool(&a.whirlpool, pool)?;
    let mint = a.position_record.position_mint;
    let position = validate_position(&a.position, pool, &mint)?;
    let vault_key = a.vault.key();
    require_keys_eq!(a.position_token_account.key(), safe_nft_ata(&vault_key, &mint), OrcaError::InvalidSafeAccount);
    require_keys_eq!(a.token_mint_a.key(), ASSETS[pool.asset_a].mint, OrcaError::InvalidPoolState);
    require_keys_eq!(a.token_mint_b.key(), ASSETS[pool.asset_b].mint, OrcaError::InvalidPoolState);
    require_keys_eq!(a.safe_token_a.key(), safe_ata(&vault_key, &ASSETS[pool.asset_a].mint), OrcaError::InvalidSafeAccount);
    require_keys_eq!(a.safe_token_b.key(), safe_ata(&vault_key, &ASSETS[pool.asset_b].mint), OrcaError::InvalidSafeAccount);
    require_keys_eq!(a.token_vault_a.key(), pool.vault_a, OrcaError::InvalidPoolState);
    require_keys_eq!(a.token_vault_b.key(), pool.vault_b, OrcaError::InvalidPoolState);
    if position.liquidity > 0 {
        require_orca_owned(&[&a.tick_array_lower, &a.tick_array_upper])?;
        update_fees(&a.vault, &a.whirlpool, &a.position, &a.tick_array_lower, &a.tick_array_upper, &a.orca_program)?;
    }
    let (before_a, before_b) = (a.safe_token_a.amount, a.safe_token_b.amount);
    let vault_info = a.vault.to_account_info();
    let metas = vec![
        meta(&a.whirlpool, false, false), meta(&vault_info, false, true), meta(&a.position, true, false),
        meta(&a.position_token_account, false, false), meta(&a.token_mint_a, false, false),
        meta(&a.token_mint_b, false, false), meta(&a.safe_token_a.to_account_info(), true, false),
        meta(&a.token_vault_a, true, false), meta(&a.safe_token_b.to_account_info(), true, false),
        meta(&a.token_vault_b, true, false), meta(&a.token_program, false, false),
        meta(&a.token_program, false, false), meta(&a.memo_program, false, false),
    ];
    let infos = [
        a.whirlpool.to_account_info(), vault_info, a.position.to_account_info(),
        a.position_token_account.to_account_info(), a.token_mint_a.to_account_info(),
        a.token_mint_b.to_account_info(), a.safe_token_a.to_account_info(), a.token_vault_a.to_account_info(),
        a.safe_token_b.to_account_info(), a.token_vault_b.to_account_info(), a.token_program.to_account_info(),
        a.memo_program.to_account_info(), a.orca_program.to_account_info(),
    ];
    let mut data = IX_COLLECT_FEES_V2.to_vec();
    data.push(0); // remaining_accounts_info = None
    invoke_orca(&a.vault, data, metas, &infos)?;

    let collected_a = token_amount(&a.safe_token_a.to_account_info())?.checked_sub(before_a).ok_or(OrcaError::BalanceDelta)?;
    let collected_b = token_amount(&a.safe_token_b.to_account_info())?.checked_sub(before_b).ok_or(OrcaError::BalanceDelta)?;
    let fee_bps = a.position_record.fee_bps;
    let (fee_a, fee_b) = (fee_split(collected_a, fee_bps), fee_split(collected_b, fee_bps));
    pay_fee(a, a.safe_token_a.to_account_info(), &a.treasury_token_a, &ASSETS[pool.asset_a].mint, fee_a)?;
    pay_fee(a, a.safe_token_b.to_account_info(), &a.treasury_token_b, &ASSETS[pool.asset_b].mint, fee_b)?;
    let r = &mut ctx.accounts.position_record;
    r.fees_collected_a = r.fees_collected_a.saturating_add(collected_a);
    r.fees_collected_b = r.fees_collected_b.saturating_add(collected_b);
    r.fees_paid_a = r.fees_paid_a.saturating_add(fee_a);
    r.fees_paid_b = r.fees_paid_b.saturating_add(fee_b);
    emit!(OrcaCollectEvent { vault: vault_key, position_mint: mint, collected_a, collected_b, fee_a, fee_b, fee_bps });
    Ok(())
}

// ---------------------------------------------------------------- LP: close

#[derive(Accounts)]
pub struct OrcaClosePosition<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"executor_registry"], bump = executor_registry.bump)]
    pub executor_registry: Box<Account<'info, ExecutorRegistry>>,
    #[account(mut, seeds = [b"orca_policy", vault.key().as_ref()], bump = orca_policy.bump,
        constraint = orca_policy.vault == vault.key() @ OrcaError::InvalidPolicy)]
    pub orca_policy: Box<Account<'info, OrcaPolicy>>,
    #[account(mut, close = receiver,
        seeds = [b"orca_position", vault.key().as_ref(), position_record.position_mint.as_ref()],
        bump = position_record.bump, constraint = position_record.vault == vault.key() @ OrcaError::InvalidPosition,
        constraint = position_record.funder == receiver.key() @ OrcaError::InvalidReceiver)]
    pub position_record: Box<Account<'info, OrcaPositionRecord>>,
    /// CHECK: must equal the record's funder; receives all position rent.
    #[account(mut)]
    pub receiver: UncheckedAccount<'info>,
    /// CHECK: Orca position PDA of the record's mint.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: the record's mint; Orca burns the NFT and closes the mint.
    #[account(mut)]
    pub position_mint: UncheckedAccount<'info>,
    /// CHECK: Safe's Token-2022 NFT ATA.
    #[account(mut)]
    pub position_token_account: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = ORCA_PROGRAM)]
    pub orca_program: UncheckedAccount<'info>,
}

/// Burn an empty position (liquidity 0, fees collected). Owner or agent. Rent goes to the funder.
pub fn handle_orca_close<'info>(ctx: Context<'_, '_, '_, 'info, OrcaClosePosition<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    orca_actor(&a.vault, &a.authority.key(), &a.executor_registry, &a.orca_policy)?;
    let pool = pool_at(a.position_record.pool)?;
    let mint = a.position_record.position_mint;
    require_keys_eq!(a.position_mint.key(), mint, OrcaError::InvalidPosition);
    let position = validate_position(&a.position, pool, &mint)?;
    require!(position.liquidity == 0, OrcaError::PositionNotEmpty);
    require_keys_eq!(a.position_token_account.key(), safe_nft_ata(&a.vault.key(), &mint), OrcaError::InvalidSafeAccount);
    let vault_info = a.vault.to_account_info();
    let metas = vec![
        meta(&vault_info, false, true), meta(&a.receiver, true, false), meta(&a.position, true, false),
        meta(&a.position_mint, true, false), meta(&a.position_token_account, true, false),
        meta(&a.token_2022_program, false, false),
    ];
    let infos = [
        vault_info, a.receiver.to_account_info(), a.position.to_account_info(), a.position_mint.to_account_info(),
        a.position_token_account.to_account_info(), a.token_2022_program.to_account_info(), a.orca_program.to_account_info(),
    ];
    invoke_orca(&a.vault, IX_CLOSE_POSITION_WITH_TOKEN_EXTENSIONS.to_vec(), metas, &infos)?;
    // Any basis left with zero liquidity is a realized loss; release it.
    let left = ctx.accounts.position_record.principal_usdc;
    let vault = &mut ctx.accounts.vault;
    vault.route_principal[ROUTE_ORCA_LP] = vault.route_principal[ROUTE_ORCA_LP].saturating_sub(left);
    let policy = &mut ctx.accounts.orca_policy;
    policy.open_positions = policy.open_positions.saturating_sub(1);
    Ok(())
}

// ---------------------------------------------------------------- owner exit with the NFT

#[derive(Accounts)]
pub struct OrcaExitNft<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"orca_policy", vault.key().as_ref()], bump = orca_policy.bump,
        constraint = orca_policy.vault == vault.key() @ OrcaError::InvalidPolicy)]
    pub orca_policy: Box<Account<'info, OrcaPolicy>>,
    /// CHECK: PDA ["orca_position", vault, mint]. Empty for an NFT that was sent to the Safe from
    /// outside; otherwise a record, closed here.
    #[account(mut)]
    pub position_record: UncheckedAccount<'info>,
    /// CHECK: receives the record rent; must equal the record's funder when a record exists.
    #[account(mut)]
    pub receiver: UncheckedAccount<'info>,
    /// CHECK: pinned pool of the record (registered positions only).
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: Orca position PDA of the mint.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: Orca-owned (registered positions with liquidity only).
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: Orca-owned (registered positions with liquidity only).
    pub tick_array_upper: UncheckedAccount<'info>,
    #[account(mint::token_program = token_2022_program)]
    pub position_mint: Box<InterfaceAccount<'info, InterfaceMint>>,
    #[account(mut, associated_token::mint = position_mint, associated_token::authority = vault,
        associated_token::token_program = token_2022_program)]
    pub safe_position_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    #[account(init_if_needed, payer = owner, associated_token::mint = position_mint,
        associated_token::authority = owner, associated_token::token_program = token_2022_program)]
    pub owner_position_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = ORCA_PROGRAM)]
    pub orca_program: UncheckedAccount<'info>,
}

/// Owner-only: move a position NFT to the owner's wallet. A registered position must have its
/// fees collected first (so the LP fee cannot be skipped) and leaves the Safe's accounting.
pub fn handle_orca_exit_nft<'info>(ctx: Context<'_, '_, '_, 'info, OrcaExitNft<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    let mint = a.position_mint.key();
    require!(is_orca_position_mint(&a.position_mint.to_account_info()), OrcaError::InvalidPosition);
    let vault_key = a.vault.key();
    let (record_key, _) = Pubkey::find_program_address(&[b"orca_position", vault_key.as_ref(), mint.as_ref()], &crate::ID);
    require_keys_eq!(a.position_record.key(), record_key, OrcaError::InvalidPosition);
    let registered = a.position_record.lamports() > 0 && *a.position_record.owner == crate::ID;
    if registered {
        let record_info = a.position_record.to_account_info();
        let record = OrcaPositionRecord::try_deserialize(&mut &record_info.try_borrow_data()?[..])?;
        require_keys_eq!(record.vault, vault_key, OrcaError::InvalidPosition);
        require_keys_eq!(record.position_mint, mint, OrcaError::InvalidPosition);
        require_keys_eq!(record.funder, a.receiver.key(), OrcaError::InvalidReceiver);
        let pool = pool_at(record.pool)?;
        validate_pool(&a.whirlpool, pool)?;
        let position = validate_position(&a.position, pool, &mint)?;
        let position = if position.liquidity > 0 {
            require_orca_owned(&[&a.tick_array_lower, &a.tick_array_upper])?;
            update_fees(&a.vault, &a.whirlpool, &a.position, &a.tick_array_lower, &a.tick_array_upper, &a.orca_program)?;
            validate_position(&a.position, pool, &mint)?
        } else {
            position
        };
        require!(position.fee_owed_a == 0 && position.fee_owed_b == 0, OrcaError::CollectFirst);
        let left = record.principal_usdc;
        close_program_account(&record_info, &a.receiver.to_account_info())?;
        let vault = &mut ctx.accounts.vault;
        vault.route_principal[ROUTE_ORCA_LP] = vault.route_principal[ROUTE_ORCA_LP].saturating_sub(left);
        let policy = &mut ctx.accounts.orca_policy;
        policy.open_positions = policy.open_positions.saturating_sub(1);
    } else {
        require!(a.position_record.data_is_empty(), OrcaError::InvalidPosition);
    }
    let a = &ctx.accounts;
    let bump = [a.vault.bump];
    let seeds: &[&[u8]] = &[b"vault", a.vault.owner.as_ref(), &bump];
    token_interface::transfer_checked(CpiContext::new_with_signer(a.token_2022_program.to_account_info(),
        TransferChecked {
            from: a.safe_position_ata.to_account_info(),
            mint: a.position_mint.to_account_info(),
            to: a.owner_position_ata.to_account_info(),
            authority: a.vault.to_account_info(),
        }, &[seeds]), 1, 0)?;
    Ok(())
}

#[error_code(offset = 7400)]
pub enum OrcaError {
    #[msg("Pool is not in the reviewed Orca list")] UnknownPool,
    #[msg("Unexpected Orca pool state or layout")] InvalidPoolState,
    #[msg("Invalid or substituted Pyth price account")] InvalidOracle,
    #[msg("Pyth price is stale")] StaleOracle,
    #[msg("Pyth confidence interval is too wide")] OracleConfidence,
    #[msg("Pool price is outside the oracle band")] PriceOutOfBand,
    #[msg("Minimum output is below the oracle floor")] Slippage,
    #[msg("Unexpected token balance change")] BalanceDelta,
    #[msg("Token account is not the Safe's ATA for this mint")] InvalidSafeAccount,
    #[msg("Invalid Orca policy")] InvalidPolicy,
    #[msg("Agent Orca actions are disabled by the owner")] AgentDisabled,
    #[msg("Pool is not enabled for the agent")] PoolDisabled,
    #[msg("Agent holding cap exceeded")] HoldLimit,
    #[msg("Position range outside the owner's policy")] InvalidRange,
    #[msg("Rebalance limit for the last 24 hours reached")] RebalanceLimit,
    #[msg("Too many open Orca positions")] TooManyPositions,
    #[msg("Invalid Orca position")] InvalidPosition,
    #[msg("Invalid liquidity amount")] InvalidLiquidity,
    #[msg("Position still has liquidity")] PositionNotEmpty,
    #[msg("Collect fees before moving the position")] CollectFirst,
    #[msg("Rent receiver must be the position funder")] InvalidReceiver,
    #[msg("Tick array is not owned by Orca")] InvalidTickArray,
    #[msg("Math overflow")] MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mainnet snapshot 2026-11-04: cbBTC/USDC tick 66578, Pyth cbBTC 77850.24792801, USDC 0.99982683.
    const SQRT_CBBTC_USDC: u128 = 514_719_168_495_456_219_172;
    fn cbbtc() -> Price { Price { price: 7_785_024_792_801, conf: 16_316_777_696, expo: -8, publish_time: 1_000 } }
    fn usdc() -> Price { Price { price: 99_982_683, conf: 6_285, expo: -8, publish_time: 1_000 } }
    fn wbtc() -> Price { Price { price: 7_768_210_136_657, conf: 8_020_314_784, expo: -8, publish_time: 1_000 } }

    #[test]
    fn mul_div_matches_wide_reference() {
        let cases: [(u128, u128, u128); 6] = [
            (u128::MAX, u128::MAX, u128::MAX),
            (u128::MAX, 2, 3),
            (1 << 100, 1 << 100, 1 << 90),
            (SQRT_CBBTC_USDC, SQRT_CBBTC_USDC, 1 << 64),
            (123_456_789, 987_654_321, 7),
            (0, u128::MAX, 1),
        ];
        assert_eq!(mul_div(cases[0].0, cases[0].1, cases[0].2), Some(u128::MAX));
        assert_eq!(mul_div(cases[1].0, cases[1].1, cases[1].2), Some(u128::MAX / 3 * 2 + (u128::MAX % 3) * 2 / 3));
        assert_eq!(mul_div(cases[2].0, cases[2].1, cases[2].2), Some(1 << 110));
        let p = mul_div(cases[3].0, cases[3].1, cases[3].2).unwrap();
        assert_eq!(p >> 64, 778); // 778.576 raw USDC per raw cbBTC
        assert_eq!(mul_div(cases[4].0, cases[4].1, cases[4].2), Some(123_456_789u128 * 987_654_321 / 7));
        assert_eq!(mul_div(cases[5].0, cases[5].1, cases[5].2), Some(0));
        assert_eq!(mul_div(u128::MAX, u128::MAX, 1), None);
        assert_eq!(mul_div(1, 1, 0), None);
    }

    #[test]
    fn oracle_conversion_and_band_match_live_snapshot() {
        // 1 cbBTC -> 77,863.73 USDC at the two feeds.
        assert_eq!(convert(100_000_000, &cbbtc(), 8, &usdc(), 6), Some(77_863_731_590));
        assert_eq!(convert(77_863_731_590, &usdc(), 6, &cbbtc(), 8), Some(99_999_999));
        let oracle = oracle_price_x64(&cbbtc(), 8, &usdc(), 6).unwrap();
        let pool = pool_price_x64(SQRT_CBBTC_USDC).unwrap();
        assert!(within_band(pool, oracle, 10)); // 0.8 bps apart
        assert!(!within_band(pool, oracle, 0));
        assert!(!within_band(pool * 101 / 100, oracle, 50));
        // cbBTC/WBTC: oracles 1.0022 vs pool 1.0007 (tick 7), ~15 bps apart.
        let o2 = oracle_price_x64(&cbbtc(), 8, &wbtc(), 8).unwrap();
        let p2 = pool_price_x64(18_453_201_241_220_755_940).unwrap();
        assert!(within_band(p2, o2, 50) && !within_band(p2, o2, 10));
    }

    #[test]
    fn swap_floor_and_price_limit() {
        assert_eq!(apply_bps_floor(10_000, 50), 9_950);
        assert_eq!(apply_bps_floor(10_000, 10_000), 0);
        let down = sqrt_price_limit(SQRT_CBBTC_USDC, true, 100).unwrap();
        let up = sqrt_price_limit(SQRT_CBBTC_USDC, false, 100).unwrap();
        assert!(down < SQRT_CBBTC_USDC && up > SQRT_CBBTC_USDC);
        // A 0.5% sqrt move is about a 1% price move.
        let p0 = pool_price_x64(SQRT_CBBTC_USDC).unwrap();
        let p1 = pool_price_x64(down).unwrap();
        assert!(p1 * 10_000 / p0 >= 9_899 && p1 * 10_000 / p0 <= 9_901);
        assert_eq!(sqrt_price_limit(MIN_SQRT_PRICE, true, 300), Some(MIN_SQRT_PRICE));
        assert_eq!(sqrt_price_limit(MAX_SQRT_PRICE, false, 300), Some(MAX_SQRT_PRICE));
    }

    fn feed_bytes(feed: &[u8; 32], price: i64, conf: u64, expo: i32, t: i64, level: u8) -> Vec<u8> {
        let mut d = PRICE_UPDATE_V2.to_vec();
        d.extend_from_slice(&[7u8; 32]); // write authority
        d.push(level);
        d.extend_from_slice(feed);
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&conf.to_le_bytes());
        d.extend_from_slice(&expo.to_le_bytes());
        d.extend_from_slice(&t.to_le_bytes());
        d.extend_from_slice(&[0u8; 8 * 4 + 8 + 1]); // prev time, ema, ema conf, slot, padding
        d
    }

    #[test]
    fn pyth_parsing_freshness_and_confidence() {
        let id = ASSETS[1].feed_id;
        let p = parse_price_update(&feed_bytes(&id, 7_785_024_792_801, 16_316_777_696, -8, 1_000, 1), &id).unwrap();
        assert_eq!(p, Price { price: 7_785_024_792_801, conf: 16_316_777_696, expo: -8, publish_time: 1_000 });
        assert!(parse_price_update(&feed_bytes(&id, 1, 0, -8, 0, 0), &id).is_err()); // partial verification
        assert!(parse_price_update(&feed_bytes(&ASSETS[2].feed_id, 1, 0, -8, 0, 1), &id).is_err()); // wrong feed
        assert!(parse_price_update(&feed_bytes(&id, -1, 0, -8, 0, 1), &id).is_err());
        let mut bad = feed_bytes(&id, 1, 0, -8, 0, 1); bad[0] ^= 1;
        assert!(parse_price_update(&bad, &id).is_err());
        assert!(check_price(&p, 1_000 + ORACLE_MAX_AGE_SECONDS).is_ok());
        assert!(check_price(&p, 1_001 + ORACLE_MAX_AGE_SECONDS).is_err());
        assert!(check_price(&p, 900).is_err()); // published far in the future
        let wide = Price { conf: p.price / 50, ..p }; // 2%
        assert!(check_price(&wide, 1_000).is_err());
    }

    fn policy_args() -> OrcaPolicyArgs {
        OrcaPolicyArgs { agent_enabled: true, pools_mask: 0b11, max_slippage_bps: 50, max_oracle_deviation_bps: 50,
            max_hold_usdc: [0, 500_000_000, 0], max_lp_principal_usdc: 500_000_000,
            min_width_ticks: 40, max_width_ticks: 4_000, max_opens_24h: 4 }
    }

    #[test]
    fn policy_bounds() {
        assert!(validate_orca_policy(&policy_args()).is_ok());
        assert!(validate_orca_policy(&OrcaPolicyArgs { max_slippage_bps: 301, ..policy_args() }).is_err());
        assert!(validate_orca_policy(&OrcaPolicyArgs { max_slippage_bps: 0, ..policy_args() }).is_err());
        assert!(validate_orca_policy(&OrcaPolicyArgs { max_oracle_deviation_bps: 201, ..policy_args() }).is_err());
        assert!(validate_orca_policy(&OrcaPolicyArgs { pools_mask: 0b100, ..policy_args() }).is_err());
        assert!(validate_orca_policy(&OrcaPolicyArgs { min_width_ticks: 0, ..policy_args() }).is_err());
        assert!(validate_orca_policy(&OrcaPolicyArgs { max_width_ticks: 10, ..policy_args() }).is_err());
        assert!(validate_orca_policy(&OrcaPolicyArgs { max_opens_24h: 25, ..policy_args() }).is_err());
    }

    #[test]
    fn agent_range_and_rebalance_limits() {
        assert!(check_agent_range(66_400, 66_800, 4, 66_578, 40, 4_000).is_ok());
        assert!(check_agent_range(66_401, 66_800, 4, 66_578, 40, 4_000).is_err()); // misaligned
        assert!(check_agent_range(66_576, 66_580, 4, 66_578, 40, 4_000).is_err()); // too narrow
        assert!(check_agent_range(60_000, 70_000, 4, 66_578, 40, 4_000).is_err()); // too wide
        assert!(check_agent_range(66_600, 66_800, 4, 66_578, 40, 4_000).is_err()); // out of range
        assert!(check_agent_range(66_800, 66_400, 4, 66_578, 40, 4_000).is_err());
        let mut p = OrcaPolicy { vault: Pubkey::default(), bump: 0, agent_enabled: true, pools_mask: 1,
            max_slippage_bps: 50, max_oracle_deviation_bps: 50, max_hold_usdc: [0; 3], max_lp_principal_usdc: 0,
            min_width_ticks: 1, max_width_ticks: 2, max_opens_24h: 2, opens_window_start: 0, opens_in_window: 0, open_positions: 0 };
        register_open(&mut p, 100_000).unwrap();
        register_open(&mut p, 100_010).unwrap();
        assert!(register_open(&mut p, 100_020).is_err());
        assert!(register_open(&mut p, 100_000 + SECONDS_PER_DAY - 1).is_err());
        register_open(&mut p, 100_000 + SECONDS_PER_DAY).unwrap();
    }

    #[test]
    fn lp_fee_is_ten_percent_of_fees_by_default_and_capped() {
        assert_eq!(DEFAULT_LP_FEE_BPS, 1_000);
        assert_eq!(MAX_LP_FEE_BPS, 2_000);
        assert_eq!(fee_split(1_234_567, DEFAULT_LP_FEE_BPS), 123_456);
        assert_eq!(fee_split(9, DEFAULT_LP_FEE_BPS), 0); // rounds down in the owner's favor
        assert_eq!(fee_split(u64::MAX, MAX_LP_FEE_BPS), (u128::from(u64::MAX) * 2_000 / 10_000) as u64);
        assert_eq!(fee_split(1_000, 0), 0);
    }

    #[test]
    fn liquidity_basis_release_preserves_every_unit() {
        let first = basis_for_liquidity(1_000_000_001, 3, 1).unwrap();
        assert_eq!(first, 333_333_333);
        assert_eq!(basis_for_liquidity(1_000_000_001 - first, 2, 2).unwrap() + first, 1_000_000_001);
        assert!(basis_for_liquidity(1, 0, 1).is_err());
        assert!(basis_for_liquidity(1, 1, 2).is_err());
        assert!(basis_for_liquidity(1, 1, 0).is_err());
        assert_eq!(basis_for_liquidity(u64::MAX, u128::MAX, u128::MAX / 2).unwrap(), u64::MAX / 2);
    }

    fn pool_bytes(pool: &Pool, sqrt: u128, tick: i32) -> Vec<u8> {
        let mut d = vec![0u8; 653];
        d[..8].copy_from_slice(&WHIRLPOOL_DISCRIMINATOR);
        d[41..43].copy_from_slice(&pool.tick_spacing.to_le_bytes());
        d[65..81].copy_from_slice(&sqrt.to_le_bytes());
        d[81..85].copy_from_slice(&tick.to_le_bytes());
        d[101..133].copy_from_slice(ASSETS[pool.asset_a].mint.as_ref());
        d[133..165].copy_from_slice(pool.vault_a.as_ref());
        d[181..213].copy_from_slice(ASSETS[pool.asset_b].mint.as_ref());
        d[213..245].copy_from_slice(pool.vault_b.as_ref());
        d
    }

    #[test]
    fn pool_and_position_layouts_are_pinned() {
        let pool = &POOLS[0];
        let d = pool_bytes(pool, SQRT_CBBTC_USDC, 66_578);
        let s = validate_pool_data(&pool.address, &ORCA_PROGRAM, &d, pool).unwrap();
        assert_eq!((s.sqrt_price, s.tick_current), (SQRT_CBBTC_USDC, 66_578));
        assert!(validate_pool_data(&POOLS[1].address, &ORCA_PROGRAM, &d, pool).is_err());
        assert!(validate_pool_data(&pool.address, &Pubkey::new_unique(), &d, pool).is_err());
        for offset in [0usize, 41, 101, 133, 181, 213] {
            let mut bad = d.clone(); bad[offset] ^= 1;
            assert!(validate_pool_data(&pool.address, &ORCA_PROGRAM, &bad, pool).is_err(), "offset {offset}");
        }
        let mint = Pubkey::new_unique();
        let mut pd = vec![0u8; 216];
        pd[..8].copy_from_slice(&POSITION_DISCRIMINATOR);
        pd[8..40].copy_from_slice(pool.address.as_ref());
        pd[40..72].copy_from_slice(mint.as_ref());
        pd[72..88].copy_from_slice(&77u128.to_le_bytes());
        pd[112..120].copy_from_slice(&5u64.to_le_bytes());
        pd[136..144].copy_from_slice(&6u64.to_le_bytes());
        let ps = validate_position_data(&pd, pool, &mint).unwrap();
        assert_eq!((ps.liquidity, ps.fee_owed_a, ps.fee_owed_b), (77, 5, 6));
        assert!(validate_position_data(&pd, &POOLS[1], &mint).is_err());
        assert!(validate_position_data(&pd, pool, &Pubkey::new_unique()).is_err());
    }

    #[test]
    fn pinned_constants_are_consistent() {
        assert_eq!(ASSETS[ASSET_USDC].mint, exponent::USDC);
        for (i, pool) in POOLS.iter().enumerate() {
            assert!(pool.asset_a < ASSET_COUNT && pool.asset_b < ASSET_COUNT && pool.asset_a != pool.asset_b);
            let oracle = Pubkey::find_program_address(&[b"oracle", pool.address.as_ref()], &ORCA_PROGRAM).0;
            assert_eq!(oracle, pool.oracle, "pool {i}");
        }
        let shard = 0u16.to_le_bytes();
        let push = pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
        for asset in ASSETS.iter() {
            let feed = Pubkey::find_program_address(&[&shard, &asset.feed_id], &push).0;
            assert_eq!(feed, asset.feed);
        }
    }
}
