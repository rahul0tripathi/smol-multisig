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
        nonce: u8,
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

        Ok(())
    }
}

#[account]
pub struct TokenAccount {
    mint: Pubkey,
    amount: u64,
    state: AccountState,
}

#[account]
pub struct TokenMint {
    authority: Pubkey,
    supply: u64,
    decimals: u8,
    symbol: String,
    name: String,
    initialized: bool, // Fixed typo
    bump: u8,
    nonce: u8,
}

#[derive(AnchorDeserialize, AnchorSerialize, PartialEq, Eq, Clone, FromPrimitive, ToPrimitive)]
pub enum AccountState {
    Uninitialized,
    Initialized,
    Frozen,
}

#[error_code]
pub enum TokenErrors {
    MintAccountAlreadyInitialized,
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
        space = 8 + 32 + 8 + 1 + (4 + 10) + (4 + 20) + 1 + 1+ 1, 
        seeds = [
            b"token-mint",
            creator.key().as_ref(),
            authority.key().as_ref(),
            &[nonce],
        ],
        bump
    )]
    mint_account: Account<'info, TokenMint>,
    system_program: Program<'info, System>,
}
