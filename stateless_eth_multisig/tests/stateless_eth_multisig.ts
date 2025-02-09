import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StatelessEthMultisig } from "../target/types/stateless_eth_multisig";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { BatchSecp256k1Signer } from "../utils/secp256k1";
import { keccak_256 } from "js-sha3";
import { Wallet } from "ethers";

describe("secp256k1-multisig", () => {
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
    .StatelessEthMultisig as Program<StatelessEthMultisig>;

  const owner1 = Wallet.createRandom();
  const owner2 = Wallet.createRandom();
  const owner3 = Wallet.createRandom();

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

    // Convert Ethereum addresses to the format expected by the program
    const owners = [owner1, owner2, owner3].map((wallet) => {
      const addr = wallet.address.slice(2); // Remove '0x' prefix
      return Buffer.from(addr, "hex");
    });
    const threshold = 2;

    console.log(owners, threshold);
    await program.methods
      .create(owners, threshold)
      .accounts({
        config: configAccount,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([configKeypair])
      .rpc();

    const account = await program.account.multiSigConfig.fetch(configAccount);
    const buffersToArrays = (buffers) => buffers.map((buf) => Array.from(buf));
    expect(buffersToArrays(account.owners)).to.deep.equal(
      buffersToArrays(owners)
    );
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
      signers: [owner2.address, owner3.address].map((addr) =>
        Buffer.from(addr.slice(2), "hex")
      ),
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

    const secp256k1Ix =
      await BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
        {
          privateKey: Buffer.from(owner2.privateKey.slice(2), "hex"),
          message: txHash,
        },
        {
          privateKey: Buffer.from(owner3.privateKey.slice(2), "hex"),
          message: txHash,
        },
      ]);

    console.log(
      "signature verification data:",
      BatchSecp256k1Signer.parseBuffer(secp256k1Ix.data)
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
      .preInstructions([secp256k1Ix])
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

      // Convert Ethereum addresses to the format expected by the program
      const owners = [owner1, owner2, owner3].map((wallet) => {
        const addr = wallet.address.slice(2); // Remove '0x' prefix
        return Buffer.from(addr, "hex");
      });
      const threshold = 2;

      await program.methods
        .create(owners, threshold)
        .accounts({
          config: configAccount,
          payer: provider.wallet.publicKey,
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
      customSigners?: Buffer[],
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
        signers: customSigners || [
          Buffer.from(owner2.address.slice(2), "hex"),
          Buffer.from(owner3.address.slice(2), "hex"),
        ],
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

      const secp256k1Ix =
        await BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
          {
            privateKey: Buffer.from(owner2.privateKey.slice(2), "hex"),
            message: txHash,
          },
          {
            privateKey: Buffer.from(owner3.privateKey.slice(2), "hex"),
            message: txHash,
          },
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
          .preInstructions([secp256k1Ix])
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

      const maliciousOwner = Wallet.createRandom();
      const secp256k1Ix =
        await BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
          {
            privateKey: Buffer.from(maliciousOwner.privateKey.slice(2), "hex"),
            message: txHash,
          },
          {
            privateKey: Buffer.from(owner3.privateKey.slice(2), "hex"),
            message: txHash,
          },
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
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([secp256k1Ix])
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

    it("rejects missing program instruction", async () => {
      const { transferIx, executeParams, txHash } = await createTransferTx(
        safeTransferAmount / 2
      );

      const secp256k1Ix =
        await BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
          {
            privateKey: Buffer.from(owner2.privateKey.slice(2), "hex"),
            message: txHash,
          },
          {
            privateKey: Buffer.from(owner3.privateKey.slice(2), "hex"),
            message: txHash,
          },
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
          })
          .remainingAccounts(remainingAccounts)
          .signers([])
          .rpc();

        expect.fail("should have rejected missing program instruction");
      } catch (e) {
        const error = e as anchor.AnchorError;
        console.log("anchor error:", {
          logs: error.logs,
          error: error.error,
        });
        expect(e.toString()).to.include("InvalidArgument");
      }
    });
    it("prevents nonce replay", async () => {
      const { transferIx, executeParams, txHash } = await createTransferTx(
        safeTransferAmount / 2
      );

      const secp256k1Ix =
        await BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
          {
            privateKey: Buffer.from(owner2.privateKey.slice(2), "hex"),
            message: txHash,
          },
          {
            privateKey: Buffer.from(owner3.privateKey.slice(2), "hex"),
            message: txHash,
          },
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
        })
        .remainingAccounts(remainingAccounts)
        .preInstructions([secp256k1Ix])
        .signers([])
        .rpc();

      try {
        await program.methods
          .execute(executeParams)
          .accounts({
            config: configAccount,
            multisigPda: multisigPda,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([secp256k1Ix])
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
        [Buffer.from(owner2.address.slice(2), "hex")]
      );

      const secp256k1Ix =
        await BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
          {
            privateKey: Buffer.from(owner2.privateKey.slice(2), "hex"),
            message: txHash,
          },
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
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([secp256k1Ix])
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
      const nonOwner = Wallet.createRandom();
      const { transferIx, executeParams, txHash } = await createTransferTx(
        safeTransferAmount,
        [
          Buffer.from(nonOwner.address.slice(2), "hex"),
          Buffer.from(owner2.address.slice(2), "hex"),
        ]
      );

      const secp256k1Ix =
        await BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
          {
            privateKey: Buffer.from(nonOwner.privateKey.slice(2), "hex"),
            message: txHash,
          },
          {
            privateKey: Buffer.from(owner2.privateKey.slice(2), "hex"),
            message: txHash,
          },
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
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([secp256k1Ix])
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
        [
          Buffer.from(owner2.address.slice(2), "hex"),
          Buffer.from(owner2.address.slice(2), "hex"),
        ]
      );

      const secp256k1Ix =
        await BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
          {
            privateKey: Buffer.from(owner2.privateKey.slice(2), "hex"),
            message: txHash,
          },
          {
            privateKey: Buffer.from(owner2.privateKey.slice(2), "hex"),
            message: txHash,
          },
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
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([secp256k1Ix])
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

      const secp256k1Ix =
        await BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
          {
            privateKey: Buffer.from(owner2.privateKey.slice(2), "hex"),
            message: txHash,
          },
          {
            privateKey: Buffer.from(owner3.privateKey.slice(2), "hex"),
            message: txHash,
          },
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
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([secp256k1Ix])
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
