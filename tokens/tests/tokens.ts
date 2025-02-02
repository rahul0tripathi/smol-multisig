import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Tokens } from "../target/types/tokens";
import { PublicKey } from "@solana/web3.js";

describe("tokens", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Tokens as Program<Tokens>;
  const provider = anchor.AnchorProvider.env();

  it("setup_mint", async () => {
    const TOKEN_SYMBOL = "HELLO";
    const TOKEN_NAME = "WORLD";
    const nonce = 0;

    const signer = (program.provider as anchor.AnchorProvider).wallet;
    const randomAuthority = anchor.web3.Keypair.generate();

    const signature = await provider.connection.requestAirdrop(
      randomAuthority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);

    const [tokenPDA, bump] = await PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("token-mint"),
        randomAuthority.publicKey.toBuffer(),
        Buffer.from([nonce]),
      ],
      program.programId
    );

    console.log("derived token address", tokenPDA.toString(), bump);

    try {
      const txn = await program.methods
        .createTokenMint(
          new anchor.BN(100000000000),
          6,
          TOKEN_SYMBOL,
          TOKEN_NAME,
          nonce
        )
        .accounts({
          creator: signer.publicKey,
          authority: randomAuthority.publicKey,
          mintAccount: tokenPDA,
        })
        .rpc({ commitment: "confirmed" });
      console.log(
        "Transaction Logs:",
        await provider.connection.getTransaction(txn, {
          commitment: "confirmed",
        })
      );
      let tokenMint = await program.account.tokenMint.fetch(tokenPDA);

      console.log(
        tokenMint.authority.toString(),
        tokenMint.initialized,
        tokenMint.supply,
        tokenMint.symbol,
        tokenMint.nonce,
        tokenMint.mintedSupply
      );

      const [tokenAccountPDA, bumpTokenAccountPDA] =
        await PublicKey.findProgramAddressSync(
          [
            anchor.utils.bytes.utf8.encode("token-account"),
            tokenPDA.toBuffer(),
            signer.publicKey.toBuffer(),
          ],
          program.programId
        );

      console.log(
        "derived token account",
        tokenAccountPDA.toString(),
        bumpTokenAccountPDA
      );
      const mintTx = await program.methods
        .mintTokens(signer.publicKey, new anchor.BN(1000000))
        .accounts({
          mintAccount: tokenPDA,
          authority: randomAuthority.publicKey,
          tokenAccount: tokenAccountPDA,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([randomAuthority])
        .rpc({ commitment: "confirmed" });

      console.log("Mint transaction signature:", mintTx);

      let tokenAccount = await program.account.tokenAccount.fetch(
        tokenAccountPDA
      );
      console.log(tokenAccount.owner.toString(), tokenAccount.amount);

      tokenMint = await program.account.tokenMint.fetch(tokenPDA);

      console.log(
        tokenMint.authority.toString(),
        tokenMint.initialized,
        tokenMint.supply,
        tokenMint.symbol,
        tokenMint.nonce,
        tokenMint.mintedSupply
      );
    } catch (error) {
      console.log((error as anchor.ProgramError).toString());
    }
  });
  it("should fail when non-authority tries to mint", async () => {
    const nonce = 0;
    const signer = (program.provider as anchor.AnchorProvider).wallet;
    const validAuthority = anchor.web3.Keypair.generate();
    const invalidAuthority = anchor.web3.Keypair.generate();

    // Airdrop to both authorities
    const signatures = await Promise.all([
      provider.connection.requestAirdrop(
        validAuthority.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      ),
      provider.connection.requestAirdrop(
        invalidAuthority.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      ),
    ]);
    await Promise.all(
      signatures.map((sig) => provider.connection.confirmTransaction(sig))
    );

    // Create token mint with valid authority
    const [tokenPDA] = await PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("token-mint"),
        validAuthority.publicKey.toBuffer(),
        Buffer.from([nonce]),
      ],
      program.programId
    );

    // Create the mint
    await program.methods
      .createTokenMint(
        new anchor.BN(100000000000),
        6,
        "TEST",
        "TEST TOKEN",
        nonce
      )
      .accounts({
        creator: signer.publicKey,
        authority: validAuthority.publicKey,
        mintAccount: tokenPDA,
      })
      .rpc();

    // Try to mint with invalid authority
    const [tokenAccountPDA] = await PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("token-account"),
        tokenPDA.toBuffer(),
        signer.publicKey.toBuffer(),
      ],
      program.programId
    );

    try {
      await program.methods
        .mintTokens(signer.publicKey, new anchor.BN(1000000))
        .accounts({
          mintAccount: tokenPDA,
          authority: invalidAuthority.publicKey,
          tokenAccount: tokenAccountPDA,
        })
        .signers([invalidAuthority])
        .rpc();

      console.log("Should have failed with unauthorized authority");
    } catch (error) {
      console.log("✅ Correctly failed with unauthorized authority");
      console.log(error.toString().includes("Constraint"));
    }
  });

  describe("token transfers", () => {
    anchor.setProvider(anchor.AnchorProvider.env());

    const program = anchor.workspace.Tokens as Program<Tokens>;
    const provider = anchor.AnchorProvider.env();

    it("should successfully transfer tokens between accounts", async () => {
      // Setup constants
      const TOKEN_SYMBOL = "TEST";
      const TOKEN_NAME = "TEST TOKEN";
      const nonce = 0;
      const INITIAL_MINT_AMOUNT = new anchor.BN(1000000);
      const TRANSFER_AMOUNT = new anchor.BN(500000);

      // Setup accounts
      const signer = (program.provider as anchor.AnchorProvider).wallet;
      const tokenAuthority = anchor.web3.Keypair.generate();
      const receiver = anchor.web3.Keypair.generate();

      // Airdrop SOL to authority
      const signature = await provider.connection.requestAirdrop(
        tokenAuthority.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(signature);

      // Generate token mint PDA
      const [tokenPDA] = await PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("token-mint"),
          tokenAuthority.publicKey.toBuffer(),
          Buffer.from([nonce]),
        ],
        program.programId
      );

      // Create token mint
      await program.methods
        .createTokenMint(
          new anchor.BN(100000000000),
          6,
          TOKEN_SYMBOL,
          TOKEN_NAME,
          nonce
        )
        .accounts({
          creator: signer.publicKey,
          authority: tokenAuthority.publicKey,
          mintAccount: tokenPDA,
        })
        .rpc();

      // Generate sender's token account PDA
      const [senderTokenAccountPDA] = await PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("token-account"),
          tokenPDA.toBuffer(),
          signer.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Mint initial tokens to sender
      await program.methods
        .mintTokens(signer.publicKey, INITIAL_MINT_AMOUNT)
        .accounts({
          mintAccount: tokenPDA,
          authority: tokenAuthority.publicKey,
          tokenAccount: senderTokenAccountPDA,
        })
        .signers([tokenAuthority])
        .rpc();

      // Generate receiver's token account PDA
      const [receiverTokenAccountPDA] = await PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("token-account"),
          tokenPDA.toBuffer(),
          receiver.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Transfer tokens
      try {
        const transferTx = await program.methods
          .transfer(receiver.publicKey, TRANSFER_AMOUNT)
          .accounts({
            sender: signer.publicKey,
            mintAccount: tokenPDA,
            tokenAccountSender: senderTokenAccountPDA,
            tokenAccountReceiver: receiverTokenAccountPDA,
          })
          .rpc({
            skipPreflight: true,
            maxRetries: 5,
            commitment: "confirmed",
          });

        console.log("Transfer transaction signature:", transferTx);

        console.log(
          "Transaction Logs:",
          await provider.connection.getTransaction(transferTx, {
            commitment: "confirmed",
          })
        );

        // Verify balances
        const senderAccount = await program.account.tokenAccount.fetch(
          senderTokenAccountPDA
        );
        const receiverAccount = await program.account.tokenAccount.fetch(
          receiverTokenAccountPDA
        );

        console.log(
          "Sender balance after transfer:",
          senderAccount.amount.toString()
        );
        console.log(
          "Receiver balance after transfer:",
          receiverAccount.amount.toString()
        );

        // Assert correct balances
        const expectedSenderBalance = INITIAL_MINT_AMOUNT.sub(TRANSFER_AMOUNT);
        const expectedReceiverBalance = TRANSFER_AMOUNT;

        console.assert(
          senderAccount.amount.eq(expectedSenderBalance),
          "Incorrect sender balance"
        );
        console.assert(
          receiverAccount.amount.eq(expectedReceiverBalance),
          "Incorrect receiver balance"
        );

        console.log("✅ Transfer test passed successfully");
      } catch (error) {
        console.error("❌ Transfer test failed:", error);
        throw error;
      }
    });

    it("should fail when trying to transfer more tokens than available", async () => {
      const nonce = 0;
      const signer = (program.provider as anchor.AnchorProvider).wallet;
      const tokenAuthority = anchor.web3.Keypair.generate();
      const receiver = anchor.web3.Keypair.generate();

      // Airdrop SOL to authority
      const signature = await provider.connection.requestAirdrop(
        tokenAuthority.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(signature);

      // Generate token mint PDA
      const [tokenPDA] = await PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("token-mint"),
          tokenAuthority.publicKey.toBuffer(),
          Buffer.from([nonce]),
        ],
        program.programId
      );

      // Create token mint
      await program.methods
        .createTokenMint(
          new anchor.BN(100000000000),
          6,
          "TEST",
          "TEST TOKEN",
          nonce
        )
        .accounts({
          creator: signer.publicKey,
          authority: tokenAuthority.publicKey,
          mintAccount: tokenPDA,
        })
        .rpc();

      // Generate sender's token account PDA
      const [senderTokenAccountPDA] = await PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("token-account"),
          tokenPDA.toBuffer(),
          signer.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Mint initial tokens to sender (1000 tokens)
      await program.methods
        .mintTokens(signer.publicKey, new anchor.BN(1000))
        .accounts({
          mintAccount: tokenPDA,
          authority: tokenAuthority.publicKey,
          tokenAccount: senderTokenAccountPDA,
        })
        .signers([tokenAuthority])
        .rpc();

      // Generate receiver's token account PDA
      const [receiverTokenAccountPDA] = await PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("token-account"),
          tokenPDA.toBuffer(),
          receiver.publicKey.toBuffer(),
        ],
        program.programId
      );

      try {
        // Try to transfer more tokens than available (2000 tokens)
        await program.methods
          .transfer(receiver.publicKey, new anchor.BN(2000))
          .accounts({
            sender: signer.publicKey,
            mintAccount: tokenPDA,
            tokenAccountSender: senderTokenAccountPDA,
            tokenAccountReceiver: receiverTokenAccountPDA,
          })
          .rpc();

        console.log("❌ Should have failed with insufficient balance");
        throw new Error("Transfer succeeded when it should have failed");
      } catch (error) {
        if (error.toString().includes("TransferSubError")) {
          console.log("✅ Correctly failed with insufficient balance");
        } else {
          throw error;
        }
      }
    });
  });
});
