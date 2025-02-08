import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StatelessMultisig } from "../target/types/stateless_multisig";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";

describe("stateless_multisig", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  async function airdropSol(address: PublicKey) {
    const signature = await provider.connection.requestAirdrop(
      address,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);
  }

  const program = anchor.workspace
    .StatelessMultisig as Program<StatelessMultisig>;

  // Create keypairs for testing
  const payer = provider.wallet;
  const owner2 = anchor.web3.Keypair.generate();
  const owner3 = anchor.web3.Keypair.generate();

  // Store accounts for later use
  let configAccount: PublicKey;
  let multisigPda: PublicKey;

  it("Creates a multisig account", async () => {
    // Generate new account for multisig config
    const configKeypair = anchor.web3.Keypair.generate();
    configAccount = configKeypair.publicKey;

    // Calculate expected PDA that will act as the multisig
    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from("multisig-signer"), configAccount.toBuffer()],
      program.programId
    );
    multisigPda = pda;

    // Set up owners and threshold
    const owners = [payer.publicKey, owner2.publicKey, owner3.publicKey];
    const threshold = 2;

    // Create multisig
    await program.methods
      .create(owners, threshold)
      .accounts({
        config: configAccount,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([configKeypair])
      .rpc();

    // Verify account data
    const account = await program.account.multiSigConfig.fetch(configAccount);
    expect(account.owners).to.deep.equal(owners);
    expect(account.threshold).to.equal(threshold);
    expect(account.nonce.toString()).to.equal("0");
    expect(account.multisigPda.toString()).to.equal(multisigPda.toString());
  });

  it("Can execute a transfer through the multisig", async () => {
    const connection = provider.connection;
    await airdropSol(multisigPda);

    const rentExemption =
      await provider.connection.getMinimumBalanceForRentExemption(0);

    const balanceBeforeTransfer = await connection.getBalance(multisigPda);
    const safeTransferAmount = balanceBeforeTransfer - rentExemption;
    console.log(safeTransferAmount, balanceBeforeTransfer, rentExemption);

    if (safeTransferAmount <= 0) {
      throw new Error("Insufficient funds for transfer after rent exemption");
    }

    const recipient = anchor.web3.Keypair.generate().publicKey;

    const transferIx = SystemProgram.transfer({
      fromPubkey: multisigPda,
      toPubkey: recipient,
      lamports: safeTransferAmount,
    });

    const accounts = transferIx.keys.map((key) => {
      if (key.pubkey == multisigPda) {
        key.isSigner = false;
      }

      return {
        pubkey: key.pubkey,
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      };
    });

    const executeParams = {
      programId: SystemProgram.programId,
      accounts: accounts,
      data: transferIx.data,
      signers: [],
      nonce: new anchor.BN(0),
    };

    const remainingAccounts = [
      ...transferIx.keys,
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ];

    console.log({
      payer: payer.publicKey,
      config: configAccount,
      multisigPda: multisigPda,
    });
    // Execute transaction
    const tx = await program.methods
      .execute(executeParams)
      .accounts({
        config: configAccount,
        multisigPda: multisigPda,
        payer: payer.publicKey,
      })
      .remainingAccounts(remainingAccounts)
      .signers([])
      .rpc({ commitment: "confirmed" });

    const logs = await connection.getTransaction(tx, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    console.log(logs);
    const recipientBalance = await connection.getBalance(recipient);
    expect(recipientBalance).to.equal(safeTransferAmount);

    const account = await program.account.multiSigConfig.fetch(configAccount);
    console.log("new nonce", account.nonce);
    expect(account.nonce.toString()).to.equal("1");
  });
});
