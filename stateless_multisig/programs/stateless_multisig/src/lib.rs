use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar::instructions::{get_instruction_relative, ID as IX_ID};

pub mod errors;
pub mod verifier;

declare_id!("8EKj21isKqgxYfMQybmGWHRCn62F5thMxeaHy3A93G6L");

#[program]
pub mod stateless_multisig {
    use super::*;

    pub fn create(
        ctx: Context<CreateMultiSigCtx>,
        signers: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        require!(
            !signers.is_empty(),
            errors::MultiSigErrors::InvalidOwnersLen
        );
        require!(
            threshold > 0 && threshold <= signers.len() as u8,
            errors::MultiSigErrors::InvalidThreshold
        );

        // Find PDA that will act as the actual multisig signer
        let (multisig_pda, bump) = Pubkey::find_program_address(
            &[b"multisig-signer", ctx.accounts.config.key().as_ref()],
            ctx.program_id,
        );

        // Initialize the configuration account
        ctx.accounts.config.nonce = 0;
        ctx.accounts.config.owners = signers;
        ctx.accounts.config.threshold = threshold;
        ctx.accounts.config.multisig_pda = multisig_pda;
        ctx.accounts.config.pda_bump = bump;

        Ok(())
    }

    pub fn execute(ctx: Context<ExecuteMultiSigTxCtx>, params: ExecuteMultiSigTx) -> Result<()> {
        // Verify nonce to prevent replay
        require_eq!(
            params.nonce,
            ctx.accounts.config.nonce,
            errors::MultiSigErrors::ErrNonceTooOld
        );

        msg!("getting instruction");

        // the instruction before execute should always be the call to the Ed25519 precompile
        let ix: Instruction = get_instruction_relative(-1, &ctx.accounts.ix_sysvar)?;

        verifier::verify(&ix, params.signers, b"hello-world")?;

        msg!("verified sigs");
        // Increment nonce
        ctx.accounts.config.nonce += 1;

        // Create instruction accounts
        let accounts: Vec<AccountMeta> = params
            .accounts
            .iter()
            .map(|acc| AccountMeta {
                pubkey: acc.pubkey,
                is_signer: acc.is_signer || acc.pubkey == ctx.accounts.multisig_pda.key(),
                is_writable: acc.is_writable,
            })
            .collect();

        let ix: Instruction = Instruction {
            program_id: params.program_id,
            accounts,
            data: params.data,
        };

        let config_key = ctx.accounts.config.key();
        // Use the stored PDA seeds for the actual multisig
        let multisig_seeds = &[
            b"multisig-signer",
            config_key.as_ref(),
            &[ctx.accounts.config.pda_bump],
        ];

        let signer = &[&multisig_seeds[..]];

        msg!("executing {}", ix.program_id);
        solana_program::program::invoke_signed(&ix, ctx.remaining_accounts, signer)?;

        Ok(())
    }
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct TransactionAccount {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct ExecuteMultiSigTx {
    pub program_id: Pubkey,
    pub accounts: Vec<TransactionAccount>,
    pub data: Vec<u8>,
    pub signers: Vec<Pubkey>,
    pub nonce: u64,
}

#[account]
pub struct MultiSigConfig {
    pub owners: Vec<Pubkey>,
    pub threshold: u8,
    pub nonce: u64,
    pub multisig_pda: Pubkey, // The actual multisig PDA that will sign transactions
    pub pda_bump: u8,         // Bump seed for the multisig PDA
}

#[derive(Accounts)]
#[instruction(signers: Vec<Pubkey>, threshold: u8)]
pub struct CreateMultiSigCtx<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + // discriminator
            4 + (32 * signers.len()) + // owners vec
            1 + // threshold
            8 + // nonce
            32 + // multisig_pda
            1, // pda_bump
        signer
    )]
    pub config: Account<'info, MultiSigConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteMultiSigTxCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub config: Account<'info, MultiSigConfig>,

    /// CHECK: This is the actual multisig PDA that will sign transactions
    #[account(
        seeds = [b"multisig-signer", config.key().as_ref()],
        bump = config.pda_bump,
    )]
    pub multisig_pda: UncheckedAccount<'info>,
    /// CHECK: The address check is needed because otherwise
    /// the supplied Sysvar could be anything else.
    /// The Instruction Sysvar has not been implemented
    /// in the Anchor framework yet, so this is the safe approach.
    #[account(address = IX_ID)]
    pub ix_sysvar: AccountInfo<'info>,
}
