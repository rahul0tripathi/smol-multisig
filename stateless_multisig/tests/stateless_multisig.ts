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
import { BatchEd25519Signer } from "../utils/ed25519";
import { keccak_256 } from "js-sha3";

describe("stateless_multisig", () => {
  function numberToLEBytes(
    num: number | anchor.BN,
    length: number = 8
  ): Buffer {
    const buf = Buffer.alloc(length);
    if (num instanceof anchor.BN) {
      buf.writeBigUInt64LE(BigInt(num.toString()));
    } else {
      buf.writeBigUInt64LE(BigInt(num));
    }
    return buf;
  }
  interface TransactionAccount {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }

  function createMultiSigTxHash(
    multisigPda: PublicKey,
    nonce: anchor.BN,
    accounts: TransactionAccount[],
    data: Buffer,
    program: PublicKey
  ): Buffer {
    const payload: Buffer[] = [];

    payload.push(Buffer.from(multisigPda.toBytes()));
    payload.push(numberToLEBytes(nonce));
    for (const account of accounts) {
      payload.push(Buffer.from(account.pubkey.toBytes()));
      payload.push(Buffer.from([account.isSigner ? 1 : 0]));
      payload.push(Buffer.from([account.isWritable ? 1 : 0]));
    }
    payload.push(Buffer.from(program.toBytes()));
    payload.push(data);

    const concatenatedPayload = Buffer.concat(payload);
    return Buffer.from(keccak_256.arrayBuffer(concatenatedPayload));
  }

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

  const payer = provider.wallet;
  const owner2 = anchor.web3.Keypair.generate();
  const owner3 = anchor.web3.Keypair.generate();

  let configAccount: PublicKey;
  let multisigPda: PublicKey;

  it("creates a multisig account", async () => {
    const configKeypair = anchor.web3.Keypair.generate();
    configAccount = configKeypair.publicKey;

    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from("multisig-signer"), configAccount.toBuffer()],
      program.programId
    );
    multisigPda = pda;

    const owners = [payer.publicKey, owner2.publicKey, owner3.publicKey];
    const threshold = 2;

    await program.methods
      .create(owners, threshold)
      .accounts({
        config: configAccount,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([configKeypair])
      .rpc();

    const account = await program.account.multiSigConfig.fetch(configAccount);
    expect(account.owners).to.deep.equal(owners);
    expect(account.threshold).to.equal(threshold);
    expect(account.nonce.toString()).to.equal("0");
    expect(account.multisigPda.toString()).to.equal(multisigPda.toString());
  });

  it("execute a transfer through the multisig", async () => {
    const connection = provider.connection;
    await airdropSol(multisigPda);

    const rentExemption = await connection.getMinimumBalanceForRentExemption(0);
    const balanceBeforeTransfer = await connection.getBalance(multisigPda);
    const safeTransferAmount = balanceBeforeTransfer - rentExemption;

    console.log("transfer setup:", {
      balanceBeforeTransfer:
        balanceBeforeTransfer / anchor.web3.LAMPORTS_PER_SOL + " SOL",
      rentExemption: rentExemption / anchor.web3.LAMPORTS_PER_SOL + " SOL",
      safeTransferAmount:
        safeTransferAmount / anchor.web3.LAMPORTS_PER_SOL + " SOL",
    });

    if (safeTransferAmount <= 0) {
      throw new Error("insufficient funds for transfer after rent exemption");
    }

    const recipient = anchor.web3.Keypair.generate().publicKey;
    console.log("recipient address:", recipient.toString());

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
      signers: [owner2.publicKey, owner3.publicKey],
      nonce: new anchor.BN(0),
    };

    const txHash = createMultiSigTxHash(
      multisigPda,
      executeParams.nonce,
      executeParams.accounts,
      Buffer.from(executeParams.data),
      executeParams.programId
    );

    console.log("transaction hash:", txHash.toString("hex"));

    const ed25519Ix =
      BatchEd25519Signer.signAndCreateVerifySignaturesInstruction([
        {
          signer: owner2,
          message: txHash,
        },
        {
          signer: owner3,
          message: txHash,
        },
      ]);

    console.log(
      "signature verification data:",
      BatchEd25519Signer.parseBuffer(ed25519Ix.data)
    );

    const remainingAccounts = [
      ...transferIx.keys,
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ];

    console.log("executing multisig transfer...");

    const tx = await program.methods
      .execute(executeParams)
      .accounts({
        config: configAccount,
        multisigPda: multisigPda,
      })
      .remainingAccounts(remainingAccounts)
      .preInstructions([ed25519Ix])
      .signers([])
      .rpc({ commitment: "confirmed" });

    console.log("transaction signature:", tx);

    const recipientBalance = await connection.getBalance(recipient);
    expect(recipientBalance).to.equal(safeTransferAmount);

    const account = await program.account.multiSigConfig.fetch(configAccount);
    console.log("multisig nonce updated to:", account.nonce.toString());
    expect(account.nonce.toString()).to.equal("1");
  });

  describe("failing cases", () => {
    let multisigPda: PublicKey;
    let configAccount: PublicKey;
    let recipient: PublicKey;
    let safeTransferAmount: number;

    beforeEach(async () => {
      const configKeypair = anchor.web3.Keypair.generate();
      configAccount = configKeypair.publicKey;

      const [pda] = await PublicKey.findProgramAddress(
        [Buffer.from("multisig-signer"), configAccount.toBuffer()],
        program.programId
      );
      multisigPda = pda;

      const owners = [payer.publicKey, owner2.publicKey, owner3.publicKey];
      const threshold = 2;

      await program.methods
        .create(owners, threshold)
        .accounts({
          config: configAccount,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([configKeypair])
        .rpc({ commitment: "confirmed" });

      await airdropSol(multisigPda);

      const balanceBeforeTransfer = await provider.connection.getBalance(
        multisigPda
      );
      const rentExemption =
        await provider.connection.getMinimumBalanceForRentExemption(0);
      safeTransferAmount = balanceBeforeTransfer - rentExemption;

      recipient = anchor.web3.Keypair.generate().publicKey;
    });

    async function createTransferTx(
      amount: number,
      customSigners?: PublicKey[],
      nonce?: anchor.BN
    ) {
      const transferIx = SystemProgram.transfer({
        fromPubkey: multisigPda,
        toPubkey: recipient,
        lamports: amount,
      });

      let accounts = transferIx.keys.map((key) => ({
        pubkey: key.pubkey,
        isSigner: key.pubkey === multisigPda ? false : key.isSigner,
        isWritable: key.isWritable,
      }));

      const executeParams = {
        programId: SystemProgram.programId,
        accounts: accounts,
        data: transferIx.data,
        signers: customSigners || [owner2.publicKey, owner3.publicKey],
        nonce: nonce || new anchor.BN(0),
      };

      const txHash = createMultiSigTxHash(
        multisigPda,
        executeParams.nonce,
        executeParams.accounts,
        Buffer.from(executeParams.data),
        executeParams.programId
      );

      return { transferIx, executeParams, txHash };
    }

    it("rejects malicious calldata modification", async () => {
      const { executeParams, txHash } = await createTransferTx(
        safeTransferAmount
      );

      const ed25519Ix =
        BatchEd25519Signer.signAndCreateVerifySignaturesInstruction([
          { signer: owner2, message: txHash },
          { signer: owner3, message: txHash },
        ]);

      const maliciousExecuteParams = {
        ...executeParams,
        data: SystemProgram.transfer({
          fromPubkey: multisigPda,
          toPubkey: recipient,
          lamports: safeTransferAmount * 2,
        }).data,
      };

      const remainingAccounts = [
        ...executeParams.accounts,
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ];

      try {
        await program.methods
          .execute(maliciousExecuteParams)
          .accounts({
            config: configAccount,
            multisigPda: multisigPda,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([ed25519Ix])
          .signers([])
          .rpc();

        expect.fail("should have rejected modified calldata");
      } catch (e) {
        const error = e as anchor.AnchorError;
        console.log("anchor error:", {
          logs: error.logs,
          error: error.error,
        });
        expect(e.toString()).to.include("InvalidMessage");
      }
    });

    it("rejects wrong signatures", async () => {
      const { executeParams, txHash } = await createTransferTx(
        safeTransferAmount
      );

      const maliciousOwner = anchor.web3.Keypair.generate();
      const ed25519Ix =
        BatchEd25519Signer.signAndCreateVerifySignaturesInstruction([
          { signer: maliciousOwner, message: txHash },
          { signer: owner3, message: txHash },
        ]);

      const remainingAccounts = [
        ...executeParams.accounts,
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ];

      try {
        await program.methods
          .execute(executeParams)
          .accounts({
            config: configAccount,
            multisigPda: multisigPda,
            payer: payer.publicKey,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([ed25519Ix])
          .signers([])
          .rpc();

        expect.fail("should have rejected invalid signatures");
      } catch (e) {
        const error = e as anchor.AnchorError;
        console.log("anchor error:", {
          logs: error.logs,
          error: error.error,
        });
        expect(e.toString()).to.include("InvalidMessageSigner");
      }
    });

    it("prevents nonce replay", async () => {
      const { transferIx, executeParams, txHash } = await createTransferTx(
        safeTransferAmount / 2
      );

      const ed25519Ix =
        BatchEd25519Signer.signAndCreateVerifySignaturesInstruction([
          { signer: owner2, message: txHash },
          { signer: owner3, message: txHash },
        ]);

      const remainingAccounts = [
        ...executeParams.accounts,
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ];

      await program.methods
        .execute(executeParams)
        .accounts({
          config: configAccount,
          multisigPda: multisigPda,
          payer: payer.publicKey,
        })
        .remainingAccounts(remainingAccounts)
        .preInstructions([ed25519Ix])
        .signers([])
        .rpc();

      try {
        await program.methods
          .execute(executeParams)
          .accounts({
            config: configAccount,
            multisigPda: multisigPda,
            payer: payer.publicKey,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([ed25519Ix])
          .signers([])
          .rpc();

        expect.fail("should have rejected nonce replay");
      } catch (e) {
        const error = e as anchor.AnchorError;
        console.log("anchor error:", {
          logs: error.logs,
          error: error.error,
        });
        expect(e.toString()).to.include("ErrNonceTooOld");
      }
    });

    it("rejects insufficient number of signers", async () => {
      const { transferIx, executeParams, txHash } = await createTransferTx(
        safeTransferAmount,
        [owner2.publicKey]
      );

      const ed25519Ix =
        BatchEd25519Signer.signAndCreateVerifySignaturesInstruction([
          { signer: owner2, message: txHash },
        ]);

      const remainingAccounts = [
        ...executeParams.accounts,
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ];

      try {
        await program.methods
          .execute(executeParams)
          .accounts({
            config: configAccount,
            multisigPda: multisigPda,
            payer: payer.publicKey,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([ed25519Ix])
          .signers([])
          .rpc();

        expect.fail("should have rejected insufficient signers");
      } catch (e) {
        const error = e as anchor.AnchorError;
        console.log("anchor error:", {
          logs: error.logs,
          error: error.error,
        });
        expect(e.toString()).to.include("ThresholdNotMet");
      }
    });

    it("rejects non-owner signers", async () => {
      const nonOwner = anchor.web3.Keypair.generate();
      const { transferIx, executeParams, txHash } = await createTransferTx(
        safeTransferAmount,
        [nonOwner.publicKey, owner2.publicKey]
      );

      const ed25519Ix =
        BatchEd25519Signer.signAndCreateVerifySignaturesInstruction([
          { signer: nonOwner, message: txHash },
          { signer: owner2, message: txHash },
        ]);

      const remainingAccounts = [
        ...executeParams.accounts,
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ];

      try {
        await program.methods
          .execute(executeParams)
          .accounts({
            config: configAccount,
            multisigPda: multisigPda,
            payer: payer.publicKey,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([ed25519Ix])
          .signers([])
          .rpc();

        expect.fail("should have rejected non-owner signers");
      } catch (e) {
        const error = e as anchor.AnchorError;
        console.log("anchor error:", {
          logs: error.logs,
          error: error.error,
        });
        expect(e.toString()).to.include("InvalidSigner");
      }
    });

    it("rejects duplicate signers", async () => {
      const { transferIx, executeParams, txHash } = await createTransferTx(
        safeTransferAmount,
        [owner2.publicKey, owner2.publicKey]
      );

      const ed25519Ix =
        BatchEd25519Signer.signAndCreateVerifySignaturesInstruction([
          { signer: owner2, message: txHash },
          { signer: owner2, message: txHash },
        ]);

      const remainingAccounts = [
        ...executeParams.accounts,
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ];

      try {
        await program.methods
          .execute(executeParams)
          .accounts({
            config: configAccount,
            multisigPda: multisigPda,
            payer: payer.publicKey,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([ed25519Ix])
          .signers([])
          .rpc();

        expect.fail("should have rejected duplicate signers");
      } catch (e) {
        const error = e as anchor.AnchorError;
        console.log("anchor error:", {
          logs: error.logs,
          error: error.error,
        });
        expect(e.toString()).to.include("DuplicateSigner");
      }
    });

    it("rejects when multisig PDA doesn't match config", async () => {
      const { transferIx, executeParams, txHash } = await createTransferTx(
        safeTransferAmount
      );

      const ed25519Ix =
        BatchEd25519Signer.signAndCreateVerifySignaturesInstruction([
          { signer: owner2, message: txHash },
          { signer: owner3, message: txHash },
        ]);

      const remainingAccounts = [
        ...executeParams.accounts,
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ];

      const [wrongPda] = await PublicKey.findProgramAddress(
        [Buffer.from("wrong-seed"), configAccount.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .execute(executeParams)
          .accounts({
            config: configAccount,
            multisigPda: wrongPda,
            payer: payer.publicKey,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([ed25519Ix])
          .signers([])
          .rpc();

        expect.fail("should have rejected wrong pda");
      } catch (e) {
        const error = e as anchor.AnchorError;
        console.log("anchor error:", {
          logs: error.logs,
          error: error.error,
        });
        expect(e.toString()).to.include("ConstraintSeeds");
      }
    });
  });
});
