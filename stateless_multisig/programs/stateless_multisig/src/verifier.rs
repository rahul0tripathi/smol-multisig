use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use anchor_lang::solana_program::ed25519_program::ID as ED25519_ID;
use anchor_lang::solana_program::instruction::Instruction;

use crate::errors::MultiSigErrors;

const SIGNATURE_LEN: usize = 64;
const PUBKEY_LEN: usize = 32;
const OFFSET_METADATA_SIZE: usize = 14;
const INSTRUCTION_INFO_SIZE: usize = 2;
const KECCAK_LEN: usize = 32;

pub fn verify(ix: &Instruction, signers: Vec<Pubkey>, multi_sig_hash: [u8; 32]) -> Result<()> {
    if ix.program_id != ED25519_ID || ix.accounts.len() != 0 {
        return Err(MultiSigErrors::InvalidEd25519Instruction.into());
    }

    // signatures count + padding + header * total_signers
    let header_size = INSTRUCTION_INFO_SIZE + (OFFSET_METADATA_SIZE * signers.len());

    // sigs are encoded just after header
    let signatures_start = header_size;
    // then all pubkeys
    let pubkeys_start = signatures_start + (signers.len() * SIGNATURE_LEN);
    // then all messages
    let messages_start = pubkeys_start + (signers.len() * PUBKEY_LEN);

    for (i, signer) in signers.iter().enumerate() {
        let pubkey_offset = pubkeys_start + (i * PUBKEY_LEN);
        let ix_pubkey_bytes = &ix.data[pubkey_offset..pubkey_offset + PUBKEY_LEN];
        let recovered_pubkey = Pubkey::new_from_array(ix_pubkey_bytes.try_into().unwrap());

        require_eq!(
            recovered_pubkey,
            signer.key(),
            MultiSigErrors::InvalidMessageSigner
        );

        let msg_offset = messages_start + (i * KECCAK_LEN);
        let ix_msg_bytes = &ix.data[msg_offset..msg_offset + KECCAK_LEN];

        require!(
            ix_msg_bytes.eq(&multi_sig_hash),
            MultiSigErrors::InvalidMessage
        );
    }

    return Ok(());
}
