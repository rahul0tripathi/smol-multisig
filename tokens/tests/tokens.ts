import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Tokens } from "../target/types/tokens";
import { PublicKey } from "@solana/web3.js";

describe("tokens", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Tokens as Program<Tokens>;

  async function airdropSol(address: PublicKey) {
    const signature = await provider.connection.requestAirdrop(
      address,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);
  }

  it("token lifecycle: create, mint, and transfer", async () => {
    // Constants
    const TOKEN_SYMBOL = "TEST";
    const TOKEN_NAME = "TEST TOKEN";
    const nonce = 0;
    const INITIAL_SUPPLY = new anchor.BN(100000000000);
    const MINT_AMOUNT = new anchor.BN(1000000);
    const TRANSFER_AMOUNT = new anchor.BN(500000);

    // Setup accounts
    const signer = provider.wallet;
    const tokenAuthority = anchor.web3.Keypair.generate();
    const invalidAuthority = anchor.web3.Keypair.generate();
    const receiver = anchor.web3.Keypair.generate();

    await airdropSol(tokenAuthority.publicKey);
    await airdropSol(invalidAuthority.publicKey);

    // Get token mint PDA
    const [tokenPDA] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("token-mint"),
        tokenAuthority.publicKey.toBuffer(),
        Buffer.from([nonce]),
      ],
      program.programId
    );

    // Get token accounts PDAs
    const [senderTokenAccountPDA] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("token-account"),
        tokenPDA.toBuffer(),
        signer.publicKey.toBuffer(),
      ],
      program.programId
    );

    const [receiverTokenAccountPDA] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("token-account"),
        tokenPDA.toBuffer(),
        receiver.publicKey.toBuffer(),
      ],
      program.programId
    );

    console.log("Test 1: Create token mint");
    const createTx = await program.methods
      .createTokenMint(INITIAL_SUPPLY, 6, TOKEN_SYMBOL, TOKEN_NAME, nonce)
      .accounts({
        authority: tokenAuthority.publicKey,
        payer: signer.publicKey,
        mintAccount: tokenPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([tokenAuthority])
      .rpc();

    let tokenMint = await program.account.tokenMint.fetch(tokenPDA);
    console.log("Token mint created:", {
      authority: tokenMint.authority.toString(),
      supply: tokenMint.supply.toString(),
      symbol: tokenMint.symbol,
      mintedSupply: tokenMint.mintedSupply.toString(),
    });

    console.log("Test 2: Mint tokens with valid authority");
    const mintTx = await program.methods
      .mintTokens(signer.publicKey, MINT_AMOUNT)
      .accounts({
        authority: tokenAuthority.publicKey,
        mintAccount: tokenPDA,
        payer: signer.publicKey,
        tokenAccount: senderTokenAccountPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([tokenAuthority])
      .rpc();

    let senderAccount = await program.account.tokenAccount.fetch(
      senderTokenAccountPDA
    );
    console.log("Initial sender balance:", senderAccount.amount.toString());

    console.log("Test 3: Attempt mint with invalid authority");
    try {
      await program.methods
        .mintTokens(signer.publicKey, MINT_AMOUNT)
        .accounts({
          authority: invalidAuthority.publicKey,
          mintAccount: tokenPDA,
          payer: signer.publicKey,
          tokenAccount: senderTokenAccountPDA,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([invalidAuthority])
        .rpc();
      throw new Error("Should have failed with invalid authority");
    } catch (error) {
      if (!error.toString().includes("Constraint")) {
        throw error;
      }
      console.log("Invalid authority mint failed as expected");
    }

    console.log("Test 4: Transfer tokens");
    const transferTx = await program.methods
      .transfer(receiver.publicKey, TRANSFER_AMOUNT)
      .accounts({
        sender: signer.publicKey,
        mintAccount: tokenPDA,
        tokenAccountSender: senderTokenAccountPDA,
        tokenAccountReceiver: receiverTokenAccountPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    senderAccount = await program.account.tokenAccount.fetch(
      senderTokenAccountPDA
    );
    const receiverAccount = await program.account.tokenAccount.fetch(
      receiverTokenAccountPDA
    );

    console.log("Final balances:", {
      sender: senderAccount.amount.toString(),
      receiver: receiverAccount.amount.toString(),
    });

    console.log("Test 5: Attempt transfer with insufficient balance");
    try {
      await program.methods
        .transfer(receiver.publicKey, MINT_AMOUNT.mul(new anchor.BN(2)))
        .accounts({
          sender: signer.publicKey,
          mintAccount: tokenPDA,
          tokenAccountSender: senderTokenAccountPDA,
          tokenAccountReceiver: receiverTokenAccountPDA,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      throw new Error("Should have failed with insufficient balance");
    } catch (error) {
      if (!error.toString().includes("TransferSubError")) {
        throw error;
      }
      console.log("Insufficient balance transfer failed as expected");
    }

    // Verify final state
    tokenMint = await program.account.tokenMint.fetch(tokenPDA);
    console.log("Final token state:", {
      mintedSupply: tokenMint.mintedSupply.toString(),
      totalSupply: tokenMint.supply.toString(),
      senderBalance: senderAccount.amount.toString(),
      receiverBalance: receiverAccount.amount.toString(),
    });
  });
});
