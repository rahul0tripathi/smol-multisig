use anchor_lang::prelude::*;

declare_id!("8EKj21isKqgxYfMQybmGWHRCn62F5thMxeaHy3A93G6L");

#[program]
pub mod stateless_multisig {
    use super::*;

    pub fn create(
        ctx: Context<CreateMultiSigAccountCtx>,
        custom_seed: [u8; 16],
        signers: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        ctx.accounts.multi_sig_account.bump = ctx.bumps.multi_sig_account;
        ctx.accounts.multi_sig_account.custom_seed = custom_seed;
        ctx.accounts.multi_sig_account.nonce = 0;
        ctx.accounts.multi_sig_account.owners = signers;
        ctx.accounts.multi_sig_account.threshold = threshold;
        return Ok(());
    }
}

#[account]
pub struct MultiSigAccount {
    owners: Vec<Pubkey>,
    threshold: u8,
    nonce: u64,
    custom_seed: [u8; 16],
    bump: u8,
}

#[derive(Accounts)]
#[instruction(custom_seed: [u8;16], signers: Vec<Pubkey>, threshold: u8)]
pub struct CreateMultiSigAccountCtx<'info> {
    #[account(mut)]
    payer: Signer<'info>,

    #[account(
        init,
        space = (signers.len() * 32) + 8 +16+ ( 8 * 16 ) + 8,
        payer=payer,
        seeds=[b"stateless-multisig" , &custom_seed[..]],
        bump
    )]
    multi_sig_account: Account<'info, MultiSigAccount>,
    system_program: Program<'info, System>,
}
