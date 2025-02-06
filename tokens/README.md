# Anchor Basics

Quick demo showing how tokens and multiple signers work in sol. built this to play around with PDAs and cross-program stuff.

## What's Inside

Two programs:

- `tokens`: Basic token program (create, mint, transfer)
- `token_multis`: Wrapper that demonstrates how multiple signers can control token operations in a single transaction, cpi and pda signing

## How it Works

The token program is pretty standard - you can create tokens, mint them (diff from SPL as the mint account here is also a PDA), and move them around. comes with a 2/2 multisig to handle token ops.

1. Two signers are required in the same transaction to create a token
2. The program creates a PDA derived from both signer public keys
3. This PDA becomes the token authority and can sign for operations via CPI calls

Note: This isn't a true multisig (where signatures can be collected over time). Instead, it shows how to require multiple signers in a single transaction and how PDAs can be used for program signing.

## Testing

Just run:

```bash
anchor test
```
