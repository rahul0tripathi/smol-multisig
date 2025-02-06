import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenMultis } from "../target/types/token_multis";
import { Tokens } from "../target/types/tokens";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { assert } from "chai";

describe("token-multis", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TokenMultis as Program<TokenMultis>;
  const tokensProgram = anchor.workspace.Tokens as Program<Tokens>;

  const signer1 = Keypair.generate();
  const signer2 = Keypair.generate();

  let multiSig: PublicKey;
  let multiSigBump: number;
  let mintAddress: PublicKey;

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

    [multiSig, multiSigBump] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("token-multis"),
        signer1.publicKey.toBuffer(),
        signer2.publicKey.toBuffer(),
      ],
      program.programId
    );

    [mintAddress] = await PublicKey.findProgramAddressSync(
      [Buffer.from("token-mint"), multiSig.toBuffer(), Buffer.from([0])],
      tokensProgram.programId
    );

    console.log("Test setup complete:");
    console.log("MultiSig PDA:", multiSig.toString());
    console.log("Mint Address:", mintAddress.toString());
  });

  describe("Multi-sig creation", () => {
    it("Creates a multi-sig account", async () => {
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

      const account = await program.account.tokenAuthMultiSig.fetch(multiSig);
      assert.equal(account.signer1.toString(), signer1.publicKey.toString());
      assert.equal(account.signer2.toString(), signer2.publicKey.toString());
      assert.equal(account.bump, multiSigBump);
      assert.equal(account.nonce.toString(), "0");
    });
  });

  describe("Token initialization", () => {
    it("Initializes token mint", async () => {
      const nonce = 0;

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

        const mintAccount = await tokensProgram.account.tokenMint.fetch(
          mintAddress
        );
        assert.equal(mintAccount.authority.toString(), multiSig.toString());
        assert.equal(mintAccount.symbol, "TEST");

        console.log("Token initialization successful:", tx);
      } catch (e) {
        console.error("\nToken initialization error:", e);
        throw e;
      }
    });
  });

  describe("Airdrop functionality", () => {
    it("Successfully airdrops to multiple users", async () => {
      const testUsers = Array.from({ length: 3 }, () => Keypair.generate());
      const airdropAmounts = [100_000, 200_000, 300_000];

      const userTokenAccounts = await Promise.all(
        testUsers.map(async (user) => {
          const [tokenAccount] = await PublicKey.findProgramAddressSync(
            [
              Buffer.from("token-account"),
              mintAddress.toBuffer(),
              user.publicKey.toBuffer(),
            ],
            tokensProgram.programId
          );
          return tokenAccount;
        })
      );

      try {
        const tx = await program.methods
          .airdrop(
            testUsers.map((key) => key.publicKey),
            airdropAmounts.map((amount) => new anchor.BN(amount))
          )
          .accounts({
            multiSig,
            signer1: signer1.publicKey,
            signer2: signer2.publicKey,
            mintAddress,
            tokenAccount: tokensProgram.programId,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(
            userTokenAccounts.map((account) => ({
              pubkey: account,
              isWritable: true,
              isSigner: false,
            }))
          )
          .signers([signer1, signer2])
          .rpc({ commitment: "confirmed" });

        console.log("Airdrop transaction successful:", tx);

        for (let i = 0; i < testUsers.length; i++) {
          const accountInfo = await tokensProgram.account.tokenAccount.fetch(
            userTokenAccounts[i]
          );
          console.log(`User ${i + 1} balance:`, accountInfo.amount.toString());
          assert.equal(
            accountInfo.amount.toString(),
            airdropAmounts[i].toString()
          );
        }
      } catch (e) {
        console.error("\nAirdrop error:", e);
        throw e;
      }
    });

    it("fails with mismatched receiver  and token account", async () => {
      const testUser = Keypair.generate();
      const [userTokenAccount] = await PublicKey.findProgramAddressSync(
        [
          Buffer.from("token-account"),
          mintAddress.toBuffer(),
          testUser.publicKey.toBuffer(),
        ],
        tokensProgram.programId
      );

      const wrongUser = Keypair.generate();

      const amounts = [new anchor.BN(100_000), new anchor.BN(200_000)]; // Two amounts but one account

      try {
        await program.methods
          .airdrop([wrongUser.publicKey], amounts)
          .accounts({
            multiSig,
            signer1: signer1.publicKey,
            signer2: signer2.publicKey,
            mintAddress,
            tokenAccount: tokensProgram.programId,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            {
              pubkey: userTokenAccount,
              isWritable: true,
              isSigner: false,
            },
          ])
          .signers([signer1, signer2])
          .rpc({ commitment: "confirmed" });

        assert.fail("Should have thrown an error");
      } catch (e) {
        console.log("this failed", e);
        assert.include(e.toString(), "ConstraintSeeds");
      }
    });

    it("fails with empty arrays", async () => {
      try {
        const testUser = Keypair.generate();
        const [userTokenAccount] = await PublicKey.findProgramAddressSync(
          [
            Buffer.from("token-account"),
            mintAddress.toBuffer(),
            testUser.publicKey.toBuffer(),
          ],
          tokensProgram.programId
        );
        await program.methods
          .airdrop([], [])
          .accounts({
            multiSig,
            signer1: signer1.publicKey,
            signer2: signer2.publicKey,
            mintAddress,
            tokenAccount: tokensProgram.programId,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            {
              pubkey: userTokenAccount,
              isWritable: true,
              isSigner: false,
            },
          ])
          .signers([signer1, signer2])
          .rpc();

        assert.fail("Should have thrown an error");
      } catch (e) {
        console.log("Expected error received:", e);
        assert.include(e.toString(), "ErrInvalidIndex");
      }
    });
  });
});
