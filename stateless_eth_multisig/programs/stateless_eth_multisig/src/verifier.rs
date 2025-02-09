use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::secp256k1_program::ID as SECP256K1_ID;

use crate::errors::MultiSigErrors;

const SIGNATURE_LEN: usize = 64;
const RECOVERY_ID_LEN: usize = 1;
const ETH_ADDRESS_LEN: usize = 20;
const OFFSET_METADATA_SIZE: usize = 11;
const INSTRUCTION_INFO_SIZE: usize = 1; // Just the number of signatures
const MESSAGE_LEN: usize = 32;

pub fn verify(ix: &Instruction, signers: Vec<[u8; 20]>, multi_sig_hash: [u8; 32]) -> Result<()> {
    if ix.program_id != SECP256K1_ID || !ix.accounts.is_empty() {
        return Err(MultiSigErrors::InvalidSecp256k1Instruction.into());
    }

    // signatures count + offset metadata for each signer
    let header_size = INSTRUCTION_INFO_SIZE + (OFFSET_METADATA_SIZE * signers.len());

    // ethereum addresses come first after header
    let addresses_start = header_size;
    // then all signatures with recovery IDs
    let signatures_start = addresses_start + (signers.len() * ETH_ADDRESS_LEN);
    // then all messages
    let messages_start = signatures_start + (signers.len() * (SIGNATURE_LEN + RECOVERY_ID_LEN));

    for (i, signer) in signers.iter().enumerate() {
        // verify ethereum address
        let addr_offset = addresses_start + (i * ETH_ADDRESS_LEN);
        let ix_addr_bytes = &ix.data[addr_offset..addr_offset + ETH_ADDRESS_LEN];
        require!(
            ix_addr_bytes.eq(signer),
            MultiSigErrors::InvalidMessageSigner
        );

        // verify message
        let msg_offset = messages_start + (i * MESSAGE_LEN);
        let ix_msg_bytes = &ix.data[msg_offset..msg_offset + MESSAGE_LEN];
        require!(
            ix_msg_bytes.eq(&multi_sig_hash),
            MultiSigErrors::InvalidMessage
        );
    }

    Ok(())
}
