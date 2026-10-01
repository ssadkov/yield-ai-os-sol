//! Unlevered ONyc 10JAN27. Typed, atomic CPIs; no caller-provided instruction bytes.
use super::*;
use crate::exponent_accounts as accounts;

pub const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const ONYC: Pubkey = pubkey!("5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5");
pub const PT: Pubkey = pubkey!("HH7FiYbEfDwQoK2ZJpkMz1T6wG6TqPsWcxWCtEVgigrZ");
pub const SY: Pubkey = pubkey!("G1qbuP11CdquJCzuDjruWqatQAHroajmxhLfeQVgHosF");
pub const YT: Pubkey = pubkey!("GFpXWuDCm7QMjkYbMveNZoLzybqJaginDDvuX3bJqgLF");
pub const CORE: Pubkey = pubkey!("ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7");
pub const CLMM: Pubkey = pubkey!("XPC1MM4dYACDfykNuXYZ5una2DsMDWL24CrYubCvarC");
pub const GENERIC_SY: Pubkey = pubkey!("XP1BRLn8eCYSygrd8er5P4GKdzqKbC3DLoSsS5UYVZy");
pub const CORE_VAULT: Pubkey = pubkey!("7f1PgxY3kGsPqLAKpwcduZkcBEhpjMz7U1iJ4pcCCzDy");
pub const SY_META: Pubkey = pubkey!("BmLiVHRb9ppTrEA5jhTgNJ2WFtjUZEkfzJZGswEidxzu");
pub const WHIRLPOOL: Pubkey = pubkey!("7jhhyxPUKpu42hPGSYwgMXbR2dtVJHKhs8DW3sAAgAvX");
pub const ORCA: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
pub const MATURITY: i64 = 1_799_586_000;
const MAX_TTL: i64 = 120;
// Upstream CLMM rounds SY input up/down across fixed-point boundaries. At 9 decimals
// at most 32 raw units may remain per action; pre-existing balances cannot be spent.
const MAX_SY_DUST: u64 = 32;
// Pilot charges no Yield AI fee, independently of the existing Kamino Config.
pub const PILOT_FEE_BPS: u16 = 0;

pub(super) struct Template { pub role: u8, pub key: Pubkey, pub writable: bool, pub signer: bool }
fn role_key(role: u8, key: Pubkey, safe: &Pubkey) -> Pubkey {
    match role {
        1 => *safe,
        2 => ata(safe, &ONYC),
        3 => ata(safe, &PT),
        4 => ata(safe, &SY),
        5 => ata(safe, &YT),
        _ => key,
    }
}
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    anchor_spl::associated_token::get_associated_token_address(owner, mint)
}
pub fn protected_mint(mint: &Pubkey) -> bool { [ONYC, PT, SY, YT].contains(mint) }
pub fn protect_generic(vault: &Vault, rem: &[AccountInfo]) -> Result<()> {
    for a in rem {
        require!(![CORE, CLMM, GENERIC_SY].contains(&a.key()), ExponentError::ProtectedAsset);
        if *a.owner == token::ID && a.data_len() == 165 {
            let d=a.try_borrow_data()?;
            let mint=Pubkey::new_from_array(d[0..32].try_into().unwrap());
            let owner=Pubkey::new_from_array(d[32..64].try_into().unwrap());
            let safe=Pubkey::find_program_address(&[b"vault", vault.owner.as_ref()], &crate::ID).0;
            require!(!(owner == safe && protected_mint(&mint)), ExponentError::ProtectedAsset);
        }
    }
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct ExponentPosition {
    pub safe: Pubkey,
    pub market: Pubkey,
    pub pt_mint: Pubkey,
    pub base_mint: Pubkey,
    pub maturity: i64,
    pub bump: u8,
    pub enabled: bool,
    pub max_loss_bps: u16,
    pub max_slippage_bps: u16,
    pub fee_bps: u16,
    pub tracked_pt: u64,
    pub principal_usdc: u64,
    pub total_spent_usdc: u64,
    pub total_received_usdc: u64,
    pub realized_basis_usdc: u64,
    pub fees_paid_usdc: u64,
    pub recovered_basis_usdc: u64,
    /// Generic SY's precise [u64;4] index, scale 1e12. Latest entry; each entry emits a snapshot.
    pub entry_nav: [u64; 4],
    pub entry_core_rate: [u64; 4],
    pub entry_slot: u64,
    pub entry_timestamp: i64,
}

#[derive(Accounts)]
pub struct InitExponentPosition<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(seeds=[b"vault", owner.key().as_ref()], bump=vault.bump, has_one=owner)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer=owner, space=8+ExponentPosition::INIT_SPACE,
        seeds=[b"exponent_position", vault.key().as_ref(), CORE_VAULT.as_ref()], bump)]
    pub position: Account<'info, ExponentPosition>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SetExponentPolicy<'info> {
    pub owner: Signer<'info>,
    #[account(seeds=[b"vault", owner.key().as_ref()], bump=vault.bump, has_one=owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds=[b"exponent_position", vault.key().as_ref(), CORE_VAULT.as_ref()],
        bump=position.bump, constraint=position.safe == vault.key())]
    pub position: Account<'info, ExponentPosition>,
}

#[derive(Accounts)]
pub struct RecoverExponent<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds=[b"vault", owner.key().as_ref()], bump=vault.bump, has_one=owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds=[b"exponent_position", vault.key().as_ref(), CORE_VAULT.as_ref()],
        bump=position.bump, constraint=position.safe == vault.key())]
    pub position: Account<'info, ExponentPosition>,
    #[account(constraint=protected_mint(&mint.key()))] pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=vault)]
    pub safe_token: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=owner)]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct OnycTransfer<'info> {
    pub owner: Signer<'info>,
    #[account(seeds=[b"vault", owner.key().as_ref()], bump=vault.bump, has_one=owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, associated_token::mint=ONYC, associated_token::authority=owner)]
    pub owner_onyc: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint=ONYC, associated_token::authority=vault)]
    pub safe_onyc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
pub fn transfer_onyc(ctx: Context<OnycTransfer>, amount: u64, deposit: bool) -> Result<()> {
    require!(amount>0,ErrorCode::ZeroAmount);
    let bump=[ctx.accounts.vault.bump];
    let seeds:&[&[u8]]=&[b"vault",ctx.accounts.vault.owner.as_ref(),&bump];
    let (from,to)=if deposit {
        (ctx.accounts.owner_onyc.to_account_info(),ctx.accounts.safe_onyc.to_account_info())
    } else {
        (ctx.accounts.safe_onyc.to_account_info(),ctx.accounts.owner_onyc.to_account_info())
    };
    let authority=if deposit {ctx.accounts.owner.to_account_info()} else {ctx.accounts.vault.to_account_info()};
    let cpi=CpiContext::new(ctx.accounts.token_program.to_account_info(),Transfer{from,to,authority});
    if deposit {token::transfer(cpi,amount)} else {token::transfer(cpi.with_signer(&[seeds]),amount)}
}
pub fn recover(ctx: Context<RecoverExponent>, amount: u64) -> Result<()> {
    require!(amount>0,ErrorCode::ZeroAmount);
    // Explicit owner-signed in-kind recovery. Available during pause/market/oracle failure.
    // It is not a realized USDC exit and cannot be invoked by an executor.
    require!(ctx.accounts.position.fee_bps==0,ExponentError::InvalidPolicy);
    let p=&mut ctx.accounts.position;
    let mut recovered_basis=0;
    if ctx.accounts.mint.key()==PT && p.tracked_pt>0 {
        let tracked_out=amount.min(p.tracked_pt);
        recovered_basis=basis_for_exit(p.principal_usdc,p.tracked_pt,tracked_out)?;
        p.tracked_pt-=tracked_out;p.principal_usdc-=recovered_basis;
        p.recovered_basis_usdc=add(p.recovered_basis_usdc,recovered_basis)?;
        ctx.accounts.vault.route_principal[ROUTE_ONYC]=p.principal_usdc;
    }
    p.enabled=false;
    let bump=[ctx.accounts.vault.bump]; let seeds:&[&[u8]]=&[b"vault",ctx.accounts.vault.owner.as_ref(),&bump];
    token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),Transfer {
        from:ctx.accounts.safe_token.to_account_info(),to:ctx.accounts.owner_token.to_account_info(),authority:ctx.accounts.vault.to_account_info()},&[seeds]),amount)?;
    emit!(ExponentRecovery{safe:ctx.accounts.vault.key(),mint:ctx.accounts.mint.key(),amount,basis_usdc:recovered_basis});
    Ok(())
}

#[derive(Accounts)]
pub struct ExponentAction<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(mut, seeds=[b"vault", vault.owner.as_ref()], bump=vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds=[b"executor_registry"], bump=executor_registry.bump)]
    pub executor_registry: Box<Account<'info, ExecutorRegistry>>,
    #[account(mut, seeds=[b"executor_limits", vault.key().as_ref()], bump=executor_limits.bump,
        constraint=executor_limits.vault == vault.key())]
    pub executor_limits: Box<Account<'info, ExecutorLimits>>,
    #[account(mut, seeds=[b"exponent_position", vault.key().as_ref(), CORE_VAULT.as_ref()],
        bump=position.bump, constraint=position.safe == vault.key())]
    pub position: Box<Account<'info, ExponentPosition>>,
    #[account(seeds=[b"config"], bump=config.bump)] pub config: Box<Account<'info, Config>>,
    #[account(mut, associated_token::mint=USDC, associated_token::authority=vault)]
    pub safe_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=ONYC, associated_token::authority=vault)]
    pub safe_onyc: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=PT, associated_token::authority=vault)]
    pub safe_pt: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=SY, associated_token::authority=vault)]
    pub safe_sy: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=YT, associated_token::authority=vault)]
    pub safe_yt: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=USDC, associated_token::authority=vault.owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=USDC, associated_token::authority=config.treasury)]
    pub treasury_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: pinned Core state, validated owner/layout/mints/maturity below.
    #[account(address=CORE_VAULT, owner=CORE)] pub core_vault: UncheckedAccount<'info>,
    /// CHECK: pinned Generic SY metadata, validated owner/layout/mints below.
    #[account(mut, address=SY_META, owner=GENERIC_SY)] pub sy_meta: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExponentOrder {
    pub amount: u64,
    pub min_intermediate: u64,
    pub min_output: u64,
    /// Server quotes are advisory; executor also enforces an owner-approved economic floor.
    pub quoted_output: u64,
    pub deadline: i64,
}

pub fn init(ctx: Context<InitExponentPosition>, max_loss_bps: u16, max_slippage_bps: u16) -> Result<()> {
    validate_policy(max_loss_bps, max_slippage_bps)?;
    let p=&mut ctx.accounts.position;
    p.safe=ctx.accounts.vault.key(); p.market=CORE_VAULT; p.pt_mint=PT; p.base_mint=ONYC;
    p.maturity=MATURITY; p.bump=ctx.bumps.position; p.enabled=true;
    p.max_loss_bps=max_loss_bps; p.max_slippage_bps=max_slippage_bps; p.fee_bps=PILOT_FEE_BPS;
    Ok(())
}
fn validate_policy(loss: u16, slippage: u16) -> Result<()> {
    require!(loss <= 500 && slippage > 0 && slippage <= 100, ExponentError::InvalidPolicy);
    Ok(())
}
pub fn set_policy(ctx: Context<SetExponentPolicy>, enabled: bool, loss: u16, slippage: u16) -> Result<()> {
    validate_policy(loss,slippage)?;
    let p=&mut ctx.accounts.position;
    p.enabled=enabled; p.max_loss_bps=loss; p.max_slippage_bps=slippage;
    Ok(())
}
fn u64_at(d: &[u8], offset: usize) -> Result<u64> {
    let raw=d.get(offset..offset+8).ok_or(ExponentError::InvalidState)?;
    Ok(u64::from_le_bytes(raw.try_into().unwrap()))
}
fn key_at(d: &[u8], offset: usize) -> Result<Pubkey> {
    let raw=d.get(offset..offset+32).ok_or(ExponentError::InvalidState)?;
    Ok(Pubkey::new_from_array(raw.try_into().unwrap()))
}
fn precise_at(d: &[u8], offset: usize) -> Result<[u64;4]> {
    Ok([u64_at(d,offset)?,u64_at(d,offset+8)?,u64_at(d,offset+16)?,u64_at(d,offset+24)?])
}
fn scope_nav(rem: &[AccountInfo],now:i64)->Result<u64> {
    let a=rem.iter().find(|a|a.key()==pubkey!("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH")).ok_or(ExponentError::InvalidAccounts)?;
    require_keys_eq!(*a.owner,pubkey!("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ"),ExponentError::InvalidState);
    let d=a.try_borrow_data()?;
    require!(d.len()==28712 && d[..8]==[89,128,118,221,6,72,180,146],ExponentError::InvalidState);
    let o=40+108*56;let value=u64_at(&d,o)?;let exp=u64_at(&d,o+8)?;let timestamp=u64_at(&d,o+24)?;
    require!(exp<=38 && timestamp<=now as u64 && now as u64-timestamp<600,ExponentError::Expired);
    let nav=if exp>=12 {u128::from(value)/10u128.pow((exp-12) as u32)} else {u128::from(value)*10u128.pow((12-exp) as u32)};
    require!(nav>0 && nav<=u128::from(u64::MAX),ExponentError::InvalidState);Ok(nav as u64)
}
fn validate_state(a: &ExponentAction) -> Result<()> {
    let c=a.core_vault.try_borrow_data()?;
    require!(c.len()>=524 && c[..8]==[211,8,232,43,2,152,117,119],ExponentError::InvalidState);
    require_keys_eq!(key_at(&c,8)?,GENERIC_SY,ExponentError::InvalidState);
    require_keys_eq!(key_at(&c,40)?,SY,ExponentError::InvalidState);
    require_keys_eq!(key_at(&c,72)?,YT,ExponentError::InvalidState);
    require_keys_eq!(key_at(&c,104)?,PT,ExponentError::InvalidState);
    let maturity=u32::from_le_bytes(c[264..268].try_into().unwrap()) as i64
        +u32::from_le_bytes(c[268..272].try_into().unwrap()) as i64;
    require!(maturity==MATURITY && a.position.maturity==MATURITY,ExponentError::InvalidState);
    let s=a.sy_meta.try_borrow_data()?;
    require!(s.len()>=260 && s[..8]==[254,147,136,16,163,203,98,93],ExponentError::InvalidState);
    require_keys_eq!(key_at(&s,8)?,SY,ExponentError::InvalidState);
    require_keys_eq!(key_at(&s,129)?,ONYC,ExponentError::InvalidState);
    // Scope(108), maximum age 600s, no hook or emissions. Layout changes require review.
    require!(s[161]==17 && s[162..170]==[108,0,255,255,255,255,255,255]
        && u64_at(&s,170)?==600 && s[178]==0 && s[179]==0
        && s[212..220]==[0;8] && s[220..224]==[1,0,0,0] && s[256..260]==[0;4],ExponentError::InvalidState);
    require_keys_eq!(key_at(&s,224)?,pubkey!("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),ExponentError::InvalidState);
    require!(a.position.fee_bps==PILOT_FEE_BPS,ExponentError::InvalidPolicy);
    Ok(())
}
fn validate_order(order: &ExponentOrder, p: &ExponentPosition, now: i64, executor: bool) -> Result<()> {
    require!(order.amount>0 && order.min_intermediate>0 && order.min_output>0,ErrorCode::ZeroAmount);
    require!(order.deadline>=now && order.deadline<=now+MAX_TTL,ExponentError::Expired);
    if executor {
        require!(p.enabled,ExponentError::Paused);
        require!(order.quoted_output>0 && order.min_output<=order.quoted_output,
            ExponentError::Slippage);
        require!(u128::from(order.min_output)*10_000 >= u128::from(order.quoted_output)
            *u128::from(10_000-p.max_slippage_bps),ExponentError::Slippage);
    }
    Ok(())
}
fn invoke_exponent<'info>(vault: &Account<'info,Vault>, rem: &[AccountInfo<'info>],
    action: u8, amount: u64, minimum: u64) -> Result<()> {
    let template: &[Template]=match action {0=>&accounts::BUY,1=>&accounts::SELL,2=>&accounts::REDEEM,_=>return err!(ExponentError::InvalidAccounts)};
    let program=if action==2 {CORE} else {CLMM};
    require!(rem.len()==template.len()+1 && rem[0].executable,ExponentError::InvalidAccounts);
    require_keys_eq!(rem[0].key(),program,ExponentError::InvalidAccounts);
    let mut metas=Vec::with_capacity(template.len());
    for (expected, actual) in template.iter().zip(&rem[1..]) {
        let key=role_key(expected.role,expected.key,&vault.key());
        require_keys_eq!(actual.key(),key,ExponentError::InvalidAccounts);
        require!(!expected.writable || actual.is_writable,ExponentError::InvalidAccounts);
        // Only this Safe receives CPI signer privilege. Outer signers are never forwarded.
        require!(!expected.signer || key==vault.key(),ExponentError::InvalidAccounts);
        metas.push(if expected.writable {AccountMeta::new(key,expected.signer)} else {AccountMeta::new_readonly(key,expected.signer)});
    }
    // Generic Scope Mint accepts an indexed nominal amount, then divides by NAV
    // to transfer/mint ONyc/SY 1:1. Wrapper's baseAmount is therefore not ONyc raw.
    let nominal=if action==0 {
        let nav=scope_nav(rem,Clock::get()?.unix_timestamp)?;
        let value=(u128::from(amount)*u128::from(nav)+999_999_999_999)/1_000_000_000_000;
        require!(value<=u128::from(u64::MAX),ExponentError::Overflow);value as u64
    } else {amount};
    let mut data=vec![match action {0=>0x0e,1=>0x0f,_=>0x27}];
    if action==0 { data.extend_from_slice(&minimum.to_le_bytes()); data.extend_from_slice(&nominal.to_le_bytes()); }
    else { data.extend_from_slice(&amount.to_le_bytes()); if action==1 {data.extend_from_slice(&minimum.to_le_bytes());} }
    if action!=2 {data.push(0);} // Option<f64> price limit = None. End-to-end minimum is mandatory.
    data.push(10); // Reviewed mint/redeem SY account boundary. Never caller-controlled.
    let bump=[vault.bump]; let seeds:&[&[u8]]=&[b"vault",vault.owner.as_ref(),&bump];
    invoke_signed(&Instruction {program_id:program, accounts:metas,data},rem,&[seeds])?;
    Ok(())
}
// Remaining Orca accounts: program, token program, Safe, pool, Safe ONyc, vault A,
// Safe USDC, vault B, tick arrays 0/1/2, oracle. Legacy SPL-only swap, exact input.
fn invoke_orca<'info>(vault: &Account<'info,Vault>, rem: &[AccountInfo<'info>],
    buy: bool, amount: u64, minimum: u64) -> Result<()> {
    require!(rem.len()==12 && rem[0].executable,ExponentError::InvalidAccounts);
    require_keys_eq!(rem[0].key(),ORCA,ExponentError::InvalidAccounts);
    let expected=[token::ID,vault.key(),WHIRLPOOL,ata(&vault.key(),&ONYC),
        pubkey!("4SNzvPoPnnzR6sz5GdEnUpSFoZQUSnpX6KpXRKzDDfLh"),ata(&vault.key(),&USDC),
        pubkey!("EFK2eCu8FoEJerhf9P877oT3wWuq5ciAGWHR21jJaebY")];
    for (a,k) in rem[1..8].iter().zip(expected) {require_keys_eq!(a.key(),k,ExponentError::InvalidAccounts);}
    require_keys_eq!(*rem[3].owner,ORCA,ExponentError::InvalidAccounts);
    let pool=rem[3].try_borrow_data()?;
    require!(pool.len()>=245,ExponentError::InvalidState);
    require_keys_eq!(key_at(&pool,101)?,ONYC,ExponentError::InvalidState);
    require_keys_eq!(key_at(&pool,181)?,USDC,ExponentError::InvalidState);
    drop(pool);
    for tick in &rem[8..11] {
        require_keys_eq!(*tick.owner,ORCA,ExponentError::InvalidAccounts);
        let data=tick.try_borrow_data()?;
        require!(data.len()==9988,ExponentError::InvalidAccounts); // fixed TickArray, no dynamic ABI
        require_keys_eq!(key_at(&data,9956)?,WHIRLPOOL,ExponentError::InvalidAccounts);
        let start=i32::from_le_bytes(data[8..12].try_into().unwrap()).to_string();
        let address=Pubkey::find_program_address(&[b"tick_array",WHIRLPOOL.as_ref(),start.as_bytes()],&ORCA).0;
        require_keys_eq!(tick.key(),address,ExponentError::InvalidAccounts);
    }
    let oracle=Pubkey::find_program_address(&[b"oracle",WHIRLPOOL.as_ref()],&ORCA).0;
    require_keys_eq!(rem[11].key(),oracle,ExponentError::InvalidAccounts);
    let mut data=vec![248,198,158,145,225,117,135,200]; // global:swap
    data.extend_from_slice(&amount.to_le_bytes()); data.extend_from_slice(&minimum.to_le_bytes());
    let price:u128=if buy {79_226_673_515_401_279_992_447_579_055} else {4_295_048_016};
    data.extend_from_slice(&price.to_le_bytes()); data.push(1); data.push(u8::from(!buy));
    let writable=[false,false,true,true,true,true,true,true,true,true,true];
    let metas=rem[1..].iter().zip(writable).enumerate().map(|(i,(a,w))|
        if w {AccountMeta::new(a.key(),i==1)} else {AccountMeta::new_readonly(a.key(),i==1)}).collect();
    let bump=[vault.bump]; let seeds:&[&[u8]]=&[b"vault",vault.owner.as_ref(),&bump];
    invoke_signed(&Instruction{program_id:ORCA,accounts:metas,data},rem,&[seeds])?;
    Ok(())
}
fn subtract(after: u64, before: u64) -> Result<u64> {
    after.checked_sub(before).ok_or_else(||error!(ExponentError::BalanceDelta))
}
fn add(a:u64,b:u64)->Result<u64>{ a.checked_add(b).ok_or_else(||error!(ExponentError::Overflow)) }
pub fn basis_for_exit(principal:u64, tracked:u64, amount:u64)->Result<u64> {
    require!(tracked>0 && amount>0 && amount<=tracked,ErrorCode::InsufficientShares);
    Ok(if amount==tracked {principal} else {(u128::from(principal)*u128::from(amount)/u128::from(tracked)) as u64})
}
pub fn check_loss(principal:u64, received:u64, max_loss:u16)->Result<()> {
    require!(u128::from(received)*10_000>=u128::from(principal)*u128::from(10_000-max_loss),ExponentError::LossLimit);
    Ok(())
}

pub fn buy<'info>(ctx: Context<'_, '_, 'info, 'info, ExponentAction<'info>>, order: ExponentOrder, with_onyc:bool)->Result<()> {
    let now=Clock::get()?;
    require_owner_or_agent(&ctx.accounts.vault,&ctx.accounts.authority.key(),&ctx.accounts.executor_registry)?;
    let executor=ctx.accounts.authority.key()!=ctx.accounts.vault.owner;
    validate_state(&ctx.accounts)?; validate_order(&order,&ctx.accounts.position,now.unix_timestamp,executor)?;
    require!(now.unix_timestamp<MATURITY,ExponentError::Matured);
    require!(ctx.accounts.vault.allocation_bps[ROUTE_ONYC]>0,ErrorCode::RouteDisabled);
    require!(!with_onyc || !executor,ErrorCode::Unauthorized);
    let orca_len=if with_onyc {0} else {12};
    require!(ctx.remaining_accounts.len()==orca_len+1+accounts::BUY.len(),ExponentError::InvalidAccounts);
    let (orca,exp)=ctx.remaining_accounts.split_at(orca_len);
    let usdc_before=ctx.accounts.safe_usdc.amount; let base_before=ctx.accounts.safe_onyc.amount;
    let pt_before=ctx.accounts.safe_pt.amount; let sy_before=ctx.accounts.safe_sy.amount;
    if !with_onyc {invoke_orca(&ctx.accounts.vault,orca,true,order.amount,order.min_intermediate)?;}
    ctx.accounts.safe_onyc.reload()?;
    let base_in=if with_onyc {order.amount} else {subtract(ctx.accounts.safe_onyc.amount,base_before)?};
    if with_onyc {require!(base_before>=base_in,ErrorCode::InsufficientShares);}
    require!(base_in>=order.min_intermediate,ExponentError::Slippage);
    invoke_exponent(&ctx.accounts.vault,exp,0,base_in,order.min_output)?;
    ctx.accounts.safe_usdc.reload()?;ctx.accounts.safe_onyc.reload()?;ctx.accounts.safe_pt.reload()?;ctx.accounts.safe_sy.reload()?;
    let spent=if with_onyc {
        require!(ctx.accounts.safe_usdc.amount==usdc_before,ExponentError::BalanceDelta);
        require!(subtract(base_before,ctx.accounts.safe_onyc.amount)?==base_in,ExponentError::BalanceDelta);
        let nav=scope_nav(exp,now.unix_timestamp)?;
        let usd=(u128::from(base_in)*u128::from(nav)+999_999_999_999_999)/1_000_000_000_000_000;
        u64::try_from(usd).map_err(|_| error!(ExponentError::InvalidState))?
    } else {subtract(usdc_before,ctx.accounts.safe_usdc.amount)?};
    let acquired=subtract(ctx.accounts.safe_pt.amount,pt_before)?;
    require!((with_onyc || spent==order.amount) && acquired>=order.min_output,ExponentError::BalanceDelta);
    require!((with_onyc || ctx.accounts.safe_onyc.amount==base_before)
        && subtract(ctx.accounts.safe_sy.amount,sy_before)?<=MAX_SY_DUST,ExponentError::Residual);
    // PT face is indexed USD (9 decimals), while actual redemption delivers ONyc.
    if executor {check_loss(spent,acquired/1000,ctx.accounts.position.max_loss_bps)?;}
    let principal=add(ctx.accounts.position.principal_usdc,spent)?;
    require!(ctx.accounts.vault.route_principal[ROUTE_ONYC]==ctx.accounts.position.principal_usdc,ExponentError::InvalidState);
    if executor {require!(principal_within_target(&ctx.accounts.vault,ROUTE_ONYC,principal,ctx.accounts.safe_usdc.amount),ErrorCode::AllocationExceeded);}
    charge_executor_volume(&ctx.accounts.vault,&ctx.accounts.authority.key(),Some(&mut ctx.accounts.executor_limits),spent,
        Some(total_principal_after(&ctx.accounts.vault,ROUTE_ONYC,principal)),now.unix_timestamp)?;
    let p=&mut ctx.accounts.position;
    p.principal_usdc=principal;p.tracked_pt=add(p.tracked_pt,acquired)?;p.total_spent_usdc=add(p.total_spent_usdc,spent)?;
    p.entry_nav=precise_at(&ctx.accounts.sy_meta.try_borrow_data()?,97)?;
    p.entry_core_rate=precise_at(&ctx.accounts.core_vault.try_borrow_data()?,337)?;
    p.entry_slot=now.slot;p.entry_timestamp=now.unix_timestamp;
    ctx.accounts.vault.route_principal[ROUTE_ONYC]=principal;ctx.accounts.vault.last_rebalance_ts=now.unix_timestamp;
    emit!(ExponentEntry{safe:ctx.accounts.vault.key(),market:CORE_VAULT,input_mint:if with_onyc {ONYC} else {USDC},input_amount:order.amount,
        basis_usdc:spent,pt_acquired:acquired,nav:p.entry_nav,core_rate:p.entry_core_rate,slot:now.slot});
    Ok(())
}
pub fn exit<'info>(ctx: Context<'_, '_, 'info, 'info, ExponentAction<'info>>, order: ExponentOrder, redeem:bool, for_onyc:bool)->Result<()> {
    let now=Clock::get()?;
    require_owner_or_agent(&ctx.accounts.vault,&ctx.accounts.authority.key(),&ctx.accounts.executor_registry)?;
    let executor=ctx.accounts.authority.key()!=ctx.accounts.vault.owner;
    validate_state(&ctx.accounts)?;validate_order(&order,&ctx.accounts.position,now.unix_timestamp,executor)?;
    require!(if redeem {now.unix_timestamp>=MATURITY} else {now.unix_timestamp<MATURITY},ExponentError::WrongLifecycle);
    let basis=basis_for_exit(ctx.accounts.position.principal_usdc,ctx.accounts.position.tracked_pt,order.amount)?;
    require!(ctx.accounts.safe_pt.amount>=ctx.accounts.position.tracked_pt,ErrorCode::InsufficientShares);
    let count=if redeem {accounts::REDEEM.len()} else {accounts::SELL.len()};
    require!(!for_onyc || !executor,ErrorCode::Unauthorized);
    let native_prefix=if for_onyc {1} else {0};
    require!(ctx.remaining_accounts.len()==native_prefix+count+1+if for_onyc {0} else {12},ExponentError::InvalidAccounts);
    let owner_onyc=if for_onyc {
        let info=&ctx.remaining_accounts[0];
        require_keys_eq!(info.key(),anchor_spl::associated_token::get_associated_token_address(&ctx.accounts.vault.owner,&ONYC),ExponentError::InvalidAccounts);
        require!(info.is_writable,ExponentError::InvalidAccounts);
        let account=Account::<TokenAccount>::try_from(info)?;
        require_keys_eq!(account.mint,ONYC,ExponentError::InvalidAccounts);
        require_keys_eq!(account.owner,ctx.accounts.vault.owner,ExponentError::InvalidAccounts);
        Some(info.to_account_info())
    } else {None};
    let remaining=&ctx.remaining_accounts[native_prefix..];
    let (exp,orca)=remaining.split_at(count+1);
    let base_before=ctx.accounts.safe_onyc.amount;let usdc_before=ctx.accounts.safe_usdc.amount;
    let pt_before=ctx.accounts.safe_pt.amount;let sy_before=ctx.accounts.safe_sy.amount;let yt_before=ctx.accounts.safe_yt.amount;
    invoke_exponent(&ctx.accounts.vault,exp,if redeem {2} else {1},order.amount,
        if for_onyc {order.min_intermediate.max(order.min_output)} else {order.min_intermediate})?;
    ctx.accounts.safe_onyc.reload()?;
    let base_in=subtract(ctx.accounts.safe_onyc.amount,base_before)?;
    require!(base_in>=order.min_intermediate,ExponentError::Slippage);
    if !for_onyc {invoke_orca(&ctx.accounts.vault,orca,false,base_in,order.min_output)?;}
    ctx.accounts.safe_usdc.reload()?;ctx.accounts.safe_onyc.reload()?;ctx.accounts.safe_pt.reload()?;ctx.accounts.safe_sy.reload()?;ctx.accounts.safe_yt.reload()?;
    let received=subtract(ctx.accounts.safe_usdc.amount,usdc_before)?;
    require!(subtract(pt_before,ctx.accounts.safe_pt.amount)?==order.amount
        && (if for_onyc {base_in>=order.min_output && received==0} else {received>=order.min_output}),ExponentError::BalanceDelta);
    require!((for_onyc || ctx.accounts.safe_onyc.amount==base_before)
        && subtract(ctx.accounts.safe_sy.amount,sy_before)?<=MAX_SY_DUST
        && ctx.accounts.safe_yt.amount==yt_before,ExponentError::Residual);
    if executor {check_loss(basis,received,ctx.accounts.position.max_loss_bps)?;
        charge_executor_volume(&ctx.accounts.vault,&ctx.accounts.authority.key(),Some(&mut ctx.accounts.executor_limits),
            received.max(basis),None,now.unix_timestamp)?;}
    require!(ctx.accounts.vault.route_principal[ROUTE_ONYC]==ctx.accounts.position.principal_usdc,ExponentError::InvalidState);
    let p=&mut ctx.accounts.position;
    p.principal_usdc-=basis;p.tracked_pt-=order.amount;p.realized_basis_usdc=add(p.realized_basis_usdc,basis)?;
    p.total_received_usdc=add(p.total_received_usdc,received)?;
    // Fee is zero for the pilot. ONyc settlement is owner-only until its fee policy is defined.
    let fee=0;
    let bump=[ctx.accounts.vault.bump];let seeds:&[&[u8]]=&[b"vault",ctx.accounts.vault.owner.as_ref(),&bump];
    if for_onyc {
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),Transfer{
            from:ctx.accounts.safe_onyc.to_account_info(),to:owner_onyc.ok_or(ExponentError::InvalidAccounts)?,authority:ctx.accounts.vault.to_account_info()},&[seeds]),base_in)?;
    } else {
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),Transfer{
            from:ctx.accounts.safe_usdc.to_account_info(),to:ctx.accounts.owner_usdc.to_account_info(),authority:ctx.accounts.vault.to_account_info()},&[seeds]),received-fee)?;
    }
    ctx.accounts.vault.route_principal[ROUTE_ONYC]=p.principal_usdc;ctx.accounts.vault.last_rebalance_ts=now.unix_timestamp;
    emit!(ExponentExit{safe:ctx.accounts.vault.key(),market:CORE_VAULT,redeem,output_mint:if for_onyc {ONYC} else {USDC},pt_burned:order.amount,
        onyc_received:base_in,usdc_received:received,basis_usdc:basis,fee_usdc:fee,slot:now.slot});
    Ok(())
}

#[event]
pub struct ExponentEntry {pub safe:Pubkey,pub market:Pubkey,pub input_mint:Pubkey,pub input_amount:u64,pub basis_usdc:u64,pub pt_acquired:u64,pub nav:[u64;4],pub core_rate:[u64;4],pub slot:u64}
#[event]
pub struct ExponentExit {pub safe:Pubkey,pub market:Pubkey,pub redeem:bool,pub output_mint:Pubkey,pub pt_burned:u64,pub onyc_received:u64,pub usdc_received:u64,pub basis_usdc:u64,pub fee_usdc:u64,pub slot:u64}
#[event]
pub struct ExponentRecovery {pub safe:Pubkey,pub mint:Pubkey,pub amount:u64,pub basis_usdc:u64}

#[error_code(offset = 7100)]
pub enum ExponentError {
    #[msg("Unsupported or substituted Exponent/Orca accounts")] InvalidAccounts,
    #[msg("Unexpected ONyc/Exponent state or position basis")] InvalidState,
    #[msg("Quote expired or deadline exceeds 120 seconds")] Expired,
    #[msg("Owner-approved Exponent policy is invalid")] InvalidPolicy,
    #[msg("Exponent executor is paused")] Paused,
    #[msg("Minimum output/slippage constraint failed")] Slippage,
    #[msg("End-to-end USDC loss exceeds owner policy")] LossLimit,
    #[msg("Cannot buy a matured PT")] Matured,
    #[msg("Use sale before maturity or redemption after maturity")] WrongLifecycle,
    #[msg("Unexpected token balance delta")] BalanceDelta,
    #[msg("Unsettled intermediate tokens: route must be atomic")] Residual,
    #[msg("Position integer overflow")] Overflow,
    #[msg("Use typed Exponent action or owner recovery for this asset")] ProtectedAsset,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn partial_basis_then_full_exit_preserves_every_unit() {
        let a=basis_for_exit(1_000_000_001,3,1).unwrap();
        assert_eq!(a,333_333_333);
        assert_eq!(basis_for_exit(1_000_000_001-a,2,2).unwrap()+a,1_000_000_001);
        assert!(basis_for_exit(1,0,1).is_err());assert!(basis_for_exit(1,1,2).is_err());
    }
    #[test] fn loss_floor_does_not_round_down_or_use_pt_face_discount() {
        assert!(check_loss(1_000_000_000,950_000_000,500).is_ok());
        assert!(check_loss(1_000_000_000,949_999_999,500).is_err());
        assert!(check_loss(1,0,500).is_err());
    }
    #[test] fn policy_cannot_expand_executor_slippage_or_loss() {
        assert!(validate_policy(500,50).is_ok());assert!(validate_policy(501,50).is_err());
        assert!(validate_policy(500,101).is_err());assert!(validate_policy(0,0).is_err());
    }
    #[test] fn immutable_templates_grant_signer_only_to_safe() {
        for t in [&accounts::BUY[..],&accounts::SELL[..],&accounts::REDEEM[..]] {
            assert!(t.iter().filter(|a|a.signer).all(|a|a.role==1));
        }
    }
}
