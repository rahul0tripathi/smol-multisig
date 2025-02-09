use anchor_lang::prelude::*;

#[error_code]
pub enum MultiSigErrors {
    #[msg("given nonce is older than the existing nonce")]
    ErrNonceTooOld,
    #[msg("not enough signers to execute transaction")]
    NotEnoughSigners,
    #[msg("owners length must be non zero")]
    InvalidOwnersLen,
    #[msg("threshold must be greater than 0 and less than or equal to owner count")]
    InvalidThreshold,
    #[msg("invalid Ed25519 verifier instruction")]
    InvalidEd25519Instruction,
    #[msg("invalid message signer")]
    InvalidMessageSigner,
    #[msg("invalid message")]
    InvalidMessage,
    #[msg("duplicate signer")]
    DuplicateSigner,
    #[msg("signers below threshold")]
    ThresholdNotMet,
    #[msg("invalid signer")]
    InvalidSigner,
}
