use anchor_lang::prelude::*;

declare_id!("FELadcrJKJ6MuDZPRb4Q2vcY82MnkZQ5WdqVH8Mv2Wcd");

#[program]
pub mod secp256k1_multisig {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
