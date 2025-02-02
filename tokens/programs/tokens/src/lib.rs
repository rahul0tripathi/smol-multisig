use anchor_lang::prelude::*;
use num_derive::*;

declare_id!("Ey6Twts9oL668Ge9ndDnLcWNvWunTkog8JMasjHDRTpt");

#[program]
pub mod tokens {
    use super::*;

    pub fn create_token_mint(
        ctx: Context<CreateTokenMint>,
        supply: u64,
        decimals: u8,
        symbol: String,
        name: String,
        nonce: u8
    ) -> Result<()> {
        msg!("Symbol length: {}", symbol.len());
        msg!("Name length: {}", name.len());
        require!(
            !ctx.accounts.mint_account.initialized,
            TokenErrors::MintAccountAlreadyInitialized
        );

        ctx.accounts.mint_account.bump = ctx.bumps.mint_account;
        ctx.accounts.mint_account.authority = ctx.accounts.authority.key();

        ctx.accounts.mint_account.name = name;
        ctx.accounts.mint_account.symbol = symbol;
        ctx.accounts.mint_account.decimals = decimals;
        ctx.accounts.mint_account.supply = supply;
        ctx.accounts.mint_account.initialized = true;
        ctx.accounts.mint_account.nonce = nonce;
        ctx.accounts.mint_account.minted_supply = 0;

        Ok(())
    }

    pub fn mint_tokens(
        ctx: Context<MintTokensToAddress>,
        target: Pubkey,
        amount: u64
    ) -> Result<()> {
        require!(
            ctx.accounts.token_account.state != AccountState::Frozen,
            TokenErrors::TokenAccountFrozen
        );
        if ctx.accounts.token_account.state == AccountState::Uninitialized {
            ctx.accounts.token_account.mint = *ctx.accounts.mint_account.to_account_info().key;
            ctx.accounts.token_account.amount = amount;
            ctx.accounts.token_account.owner = target;
            ctx.accounts.token_account.state = AccountState::Initialized;
            ctx.accounts.token_account.bump = ctx.bumps.token_account;
        } else {
            ctx.accounts.token_account.amount = ctx.accounts.token_account.amount
                .checked_add(amount)
                .ok_or(TokenErrors::Overflow)?;
        }
        let new_supply = ctx.accounts.mint_account.minted_supply
            .checked_add(amount)
            .ok_or(TokenErrors::Overflow)?;

        require!(new_supply <= ctx.accounts.mint_account.supply, TokenErrors::ExceedsSupply);

        ctx.accounts.mint_account.minted_supply = new_supply;
        return Ok(());
    }

    pub fn transfer(ctx: Context<TransferTo>, receiver: Pubkey, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.token_account_receiver.state != AccountState::Frozen ||
                ctx.accounts.token_account_sender.state != AccountState::Frozen,
            TokenErrors::TokenAccountFrozen
        );

        ctx.accounts.token_account_sender.amount = ctx.accounts.token_account_sender.amount
            .checked_sub(amount)
            .ok_or(TokenErrors::TransferSubError)?;

        if ctx.accounts.token_account_receiver.state == AccountState::Uninitialized {
            ctx.accounts.token_account_receiver.mint =
                *ctx.accounts.mint_account.to_account_info().key;
            ctx.accounts.token_account_receiver.amount = amount;
            ctx.accounts.token_account_receiver.owner = receiver;
            ctx.accounts.token_account_receiver.state = AccountState::Initialized;
            ctx.accounts.token_account_receiver.bump = ctx.bumps.token_account_receiver;
        } else {
            ctx.accounts.token_account_receiver.amount = ctx.accounts.token_account_receiver.amount
                .checked_add(amount)
                .ok_or(TokenErrors::Overflow)?;
        }

        return Ok(());
    }
}

#[account]
pub struct TokenAccount {
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    state: AccountState,
    bump: u8,
}

#[account]
pub struct TokenMint {
    authority: Pubkey,
    supply: u64,
    decimals: u8,
    symbol: String,
    name: String,
    initialized: bool,
    minted_supply: u64,
    bump: u8,
    nonce: u8,
}

#[derive(
    AnchorDeserialize,
    AnchorSerialize,
    PartialEq,
    Eq,
    Clone,
    FromPrimitive,
    ToPrimitive,
    Default
)]
pub enum AccountState {
    #[default]
    Uninitialized,
    Initialized,
    Frozen,
}

#[error_code]
pub enum TokenErrors {
    MintAccountAlreadyInitialized,
    TokenAccountFrozen,
    Overflow,
    ExceedsSupply,
    TransferSubError,
}

#[derive(Accounts)]
#[instruction(receiver: Pubkey)]
pub struct TransferTo<'info> {
    #[account(mut)]
    sender: Signer<'info>,
    #[account(
        mut,
        seeds=[
            b"token-mint",
            mint_account.authority.key().as_ref(),
            &[mint_account.nonce],
        ],
        bump=mint_account.bump,
    )]
    mint_account: Account<'info, TokenMint>,

    #[account(
        mut,
        seeds = [b"token-account", mint_account.key().as_ref(), sender.key().as_ref()],
        bump = token_account_sender.bump,
        constraint = token_account_sender.owner == sender.key()
    )]
    token_account_sender: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = sender,
        space = 8 + 32 + 32 + 8 + 1 + 1,
        seeds = [b"token-account", mint_account.key().as_ref(), receiver.as_ref()],
        bump,
        constraint = token_account_receiver.owner == receiver ||
        token_account_receiver.state == AccountState::Uninitialized
    )]
    token_account_receiver: Account<'info, TokenAccount>,
    system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce:u8)]
pub struct CreateTokenMint<'info> {
    #[account(mut)]
    creator: Signer<'info>,
    /// CHECK: only used to set authority of the mint
    authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + 32 + 8 + 1 + (4 + 10) + (4 + 20) + 1 + 1 + 1 + 8,
        seeds = [b"token-mint", authority.key().as_ref(), &[nonce]],
        bump
    )]
    mint_account: Account<'info, TokenMint>,
    system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(receiver: Pubkey)]
pub struct MintTokensToAddress<'info> {
    #[account(mut)]
    authority: Signer<'info>,
    // ensure the mint account exists and the signer is the owner
    #[account(
        mut,
        seeds=[
            b"token-mint",
            authority.key().as_ref(),
            &[mint_account.nonce],
        ],
        bump=mint_account.bump,
        constraint = mint_account.authority == authority.key(),
    )]
    mint_account: Account<'info, TokenMint>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + 32 + 32 + 8 + 1 + 1,
        seeds = [b"token-account", mint_account.key().as_ref(), receiver.as_ref()],
        bump,
        constraint = token_account.owner == receiver ||
        token_account.state == AccountState::Uninitialized
    )]
    token_account: Account<'info, TokenAccount>,
    system_program: Program<'info, System>,
}
