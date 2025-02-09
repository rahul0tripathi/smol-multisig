# smol multisig

A poc demonstrating stateless multisig approaches on solana, inspired by [Safe's](https://github.com/safe-global/safe-smart-account) architecture.

## overview

This repository contains two programs that showcase different approaches to implementing stateless multisigs on solana:

### 1. native multisig (Ed25519)

An implementation of a stateless multisig protocol utilizing Ed25519 signatures with off-chain transaction composition. Unlike conventional solana multisig implementations that require on-chain storage of proposed transactions, this approach eliminates account management overhead by moving the transaction proposal and signature aggregation off-chain, following architectural patterns similar to Safe protocol.

[View implementation](https://github.com/rahul0tripathi/smol-anchor/blob/master/stateless_multisig/programs/stateless_multisig/src/lib.rs)

### 2. ethereum compatible multisig

An implementation leveraging solana's native secp256k1 signature verification precompiles to enable direct ethereum wallet compatibility. This design allows for seamless integration with existing ethereum infrastructure while maintaining solana's execution model, enabling cross-chain key management without additional signing infrastructure.

[View implementation](https://github.com/rahul0tripathi/smol-anchor/blob/master/stateless_eth_multisig/programs/stateless_eth_multisig/src/lib.rs)

## Technical Improvements

- Off-chain transaction storage
- No rent management overhead
- Simplified account lifecycle
- Off-chain signature aggregation
- Native Ethereum wallet compatibility (secp256k1 version)

## pls

this is just a **POC**

## testing it out

1. clone the repository
2. go to the desired folder
3. install dependencies

```bash
yarn install
```

3. Run tests

```bash
anchor test
```

## How It Works

1. The multisig configuration (owners and threshold) is stored on-chain
2. Transaction proposals and signature collection happen off-chain
3. The final execution requires only a single on-chain transaction with aggregated signatures
4. The program verifies signatures and executes the transaction atomically

## Transaction Structure

The base multisig implementation is derived from [coral-xyz/multisig](https://github.com/coral-xyz/multisig).
This implementation extends it by first using solana's native instructions to verify message signatures (Ed25519/secp256k1), followed by introspecting the verified call data within the multisig program.

The multisig uses a composite hash structure to uniquely identify and secure transaction details. The hash combines the multisig address, nonce, account metadata, and instruction data to prevent any post-signature modifications:

### Layout

```
[u8; 32]  multisig_pda      // The program derived address of the multisig
[u8; 8]   nonce             // Transaction nonce (little-endian)
[u8; 32]  account_pubkey    // For each account: public key
[u8; 1]   is_signer         // For each account: signer flag
[u8; 1]   is_writable       // For each account: writable flag
[u8; 32]  program_id        // Target program to execute
[u8; N]   instruction_data  // Raw instruction data
```

### Implementation

```rust
fn create_multi_sig_tx_hash(
    multisig_pda: Pubkey,
    nonce: u64,
    accounts: Vec<TransactionAccount>,
    data: &[u8],
    program: Pubkey,
) -> [u8; 32] {
    let mut payload = Vec::new();

    // Add multisig PDA
    payload.extend_from_slice(&multisig_pda.to_bytes());

    // Add nonce in little-endian
    payload.extend_from_slice(&nonce.to_le_bytes());

    // Add account info
    for account in accounts.iter() {
        payload.extend_from_slice(&account.pubkey.to_bytes());
        payload.push(account.is_signer as u8);
        payload.push(account.is_writable as u8);
    }

    // Add program ID and instruction data
    payload.extend_from_slice(&program.to_bytes());
    payload.extend_from_slice(data);

    // Generate keccak hash
    keccak::hash(&payload).to_bytes()
}
```

Check the test files for detailed usage examples and the various checks implemented.
