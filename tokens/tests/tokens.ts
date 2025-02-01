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

    const [tokenPDA, bump] = await PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("token-mint"),
        signer.publicKey.toBuffer(),
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
        tokenMint.nonce
      );
    } catch (error) {
      console.log((error as anchor.ProgramError).toString());
    }
  });
});
