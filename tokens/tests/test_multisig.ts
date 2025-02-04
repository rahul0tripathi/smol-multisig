import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenMultis } from "../target/types/token_multis";
import { Tokens } from "../target/types/tokens";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";

describe("token-multis", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TokenMultis as Program<TokenMultis>;
  const tokensProgram = anchor.workspace.Tokens as Program<Tokens>;

  const signer1 = Keypair.generate();
  const signer2 = Keypair.generate();

  before(async () => {
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: await provider.connection.requestAirdrop(
        signer1.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      ),
    });
  });

  it("Initializes token mint", async () => {
    const nonce = 0;

    // Get the multisig PDA
    const [multiSig, multiSigBump] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("token-multis"),
        signer1.publicKey.toBuffer(),
        signer2.publicKey.toBuffer(),
      ],
      program.programId
    );
    console.log("MultiSig PDA:", multiSig.toString());

    // Create the multisig first
    await program.methods
      .createMultiSig()
      .accounts({
        signer1: signer1.publicKey,
        signer2: signer2.publicKey,
        multiSig,
        systemProgram: SystemProgram.programId,
      })
      .signers([signer1, signer2])
      .rpc();

    console.log("\nDebuagging PDA derivation:");
    console.log("Tokens Program ID:", tokensProgram.programId.toString());
    console.log("MultiSig (creator):", multiSig.toString());
    console.log("Nonce:", nonce);

    let acc = await program.account.tokenAuthMultiSig.fetch(multiSig);
    console.log(acc.bump, acc.nonce, acc.signer1.toString());

    // Calculate mint address
    const [mintAddress] = await PublicKey.findProgramAddressSync(
      [Buffer.from("token-mint"), multiSig.toBuffer(), Buffer.alloc(1)],
      tokensProgram.programId
    );
    console.log("Calculated mint address:", mintAddress.toString());

    try {
      const tx = await program.methods
        .initTokenMint({
          supply: new anchor.BN(1_000_000),
          decimals: 9,
          symbol: "TEST",
          name: "Test Token",
          nonce,
        })
        .accounts({
          multiSig,
          signer1: signer1.publicKey,
          signer2: signer2.publicKey,
          mintAddress,
          tokenAccount: tokensProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([signer1, signer2])
        .rpc({ commitment: "confirmed" });

      console.log(
        await provider.connection.getTransaction(tx, {
          commitment: "confirmed",
        })
      );
      const account = await tokensProgram.account.tokenMint.fetch(mintAddress);
      console.log(account.authority.toString(), account.bump, account.symbol);
    } catch (e) {
      // Print more details about the
      //  error
      console.error("\nDetailed error:", e);
      throw e;
    }
  });
});
