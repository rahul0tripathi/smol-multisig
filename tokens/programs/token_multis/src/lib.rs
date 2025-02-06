use anchor_lang::prelude::*;
use tokens::program::Tokens;

declare_id!("ARZwsKQe2Vw7X8gwwyDjVaqGqxThfsJ6wmRe6caMJ7cW");

#[program]
pub mod token_multis {
    use super::*;

    pub fn create_multi_sig(ctx: Context<CreateMultiSigContext>) -> Result<()> {
        msg!("Creating multi-signature account");

        ctx.accounts.multi_sig.bump = ctx.bumps.multi_sig;
        ctx.accounts.multi_sig.signer1 = ctx.accounts.signer1.key();
        ctx.accounts.multi_sig.signer2 = ctx.accounts.signer2.key();
        ctx.accounts.multi_sig.nonce = 0;

        Ok(())
    }

    pub fn init_token_mint(
        ctx: Context<InitTokenMintContext>,
        inputs: TokenMintInputs,
    ) -> Result<()> {
        let sig1 = ctx.accounts.signer1.key();
        let sig2 = ctx.accounts.signer2.key();
        let multi_sig_bump = ctx.accounts.multi_sig.bump;
        let multi_sig_seeds = &[
            b"token-multis",
            sig1.as_ref(),
            sig2.as_ref(),
            &[multi_sig_bump],
        ];

        let signature = &[&multi_sig_seeds[..]];
        let create_mint_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_account.to_account_info(),
            tokens::cpi::accounts::CreateTokenMint {
                authority: ctx.accounts.multi_sig.to_account_info(),
                payer: ctx.accounts.signer1.to_account_info(),
                mint_account: ctx.accounts.mint_address.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            signature,
        );

        tokens::cpi::create_token_mint(
            create_mint_ctx,
            inputs.supply,
            inputs.decimals,
            inputs.symbol,
            inputs.name,
            inputs.nonce,
        )
    }

    pub fn airdrop<'info>(
        ctx: Context<'_, '_, '_, 'info, AirdropTokenContext<'info>>,
        users: Vec<Pubkey>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        let sig1 = ctx.accounts.signer1.key();
        let sig2 = ctx.accounts.signer2.key();
        let multi_sig_bump = ctx.accounts.multi_sig.bump;
        let multi_sig_seeds = &[
            b"token-multis",
            sig1.as_ref(),
            sig2.as_ref(),
            &[multi_sig_bump],
        ];

        let signature = &[&multi_sig_seeds[..]];

        let accounts = ctx.remaining_accounts.iter().cloned();

        for (index, token_account) in accounts.enumerate() {
            let create_airdrop_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_account.to_account_info(),
                tokens::cpi::accounts::MintTokensToAddress {
                    authority: ctx.accounts.multi_sig.to_account_info(),
                    payer: ctx.accounts.signer1.to_account_info(),
                    mint_account: ctx.accounts.mint_address.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_account: token_account.to_account_info(),
                },
                signature,
            );
            let amount = amounts.get(index).ok_or(MultiSigErrors::ErrInvalidIndex)?;
            let user = users.get(index).ok_or(MultiSigErrors::ErrInvalidIndex)?;

            tokens::cpi::mint_tokens(create_airdrop_ctx, user.key(), *amount)?;
        }

        return Ok(());
    }
}

#[error_code]
pub enum MultiSigErrors {
    ErrInvalidIndex,
    ErrFailedToAirdropUser,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct TokenMintInputs {
    supply: u64,
    decimals: u8,
    symbol: String,
    name: String,
    nonce: u8,
}

#[account]
pub struct TokenAuthMultiSig {
    bump: u8,
    signer1: Pubkey,
    signer2: Pubkey,
    nonce: u64,
}

#[derive(Accounts)]
pub struct CreateMultiSigContext<'info> {
    #[account(mut)]
    signer1: Signer<'info>,
    signer2: Signer<'info>,

    #[account(
        init,
        payer = signer1,
        space = 8 + 1 + (32*2) + 8,
        seeds = [b"token-multis", signer1.key().as_ref(), signer2.key().as_ref()],
        bump
    )]
    multi_sig: Account<'info, TokenAuthMultiSig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(inputs: TokenMintInputs)]
pub struct InitTokenMintContext<'info> {
    #[account(
        mut,
        seeds = [b"token-multis", signer1.key().as_ref(), signer2.key().as_ref()],
        bump = multi_sig.bump
    )]
    multi_sig: Account<'info, TokenAuthMultiSig>,

    #[account(mut)]
    signer1: Signer<'info>,
    #[account(mut)]
    signer2: Signer<'info>,

    #[account(mut)]
    /// CHECK: handled by the CPI call
    mint_address: AccountInfo<'info>,

    token_account: Program<'info, Tokens>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AirdropTokenContext<'info> {
    #[account(
        mut,
        seeds = [b"token-multis", signer1.key().as_ref(), signer2.key().as_ref()],
        bump = multi_sig.bump
    )]
    multi_sig: Account<'info, TokenAuthMultiSig>,
    #[account(mut)]
    signer1: Signer<'info>,
    #[account(mut)]
    signer2: Signer<'info>,

    #[account(mut)]
    /// CHECK: handled by the CPI call
    mint_address: AccountInfo<'info>,

    token_account: Program<'info, Tokens>,
    pub system_program: Program<'info, System>,
}
