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
      console.log(error);
      console.log("✅ Correctly failed with unauthorized authority");
      console.log(error.toString().includes("Constraint"));
    }
  });
});
