import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Wallet, randomBytes, SigningKey } from "ethers";
import { BatchSecp256k1Signer } from "../utils/secp256k1";

const RPC_URL = "http://localhost:8899";
const AIRDROP_AMOUNT = 1_000_000_000; // 1 SOL
const TX_OPTIONS = {
  commitment: "confirmed" as const,
  maxRetries: 5,
};

const TEST_MESSAGES = {
  first: Buffer.from("hello-world"),
  second: Buffer.from("hello-world-second"),
};

function generateRandomWallet(): { privateKey: Uint8Array; wallet: Wallet } {
  const privateKeyBytes = randomBytes(32);
  const wallet = new Wallet(new SigningKey(privateKeyBytes));
  return { privateKey: privateKeyBytes, wallet };
}

async function initializeTestEnvironment(): Promise<{
  connection: Connection;
  payer: Keypair;
}> {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.generate();

  console.log("[Setup] Initializing test environment");
  const signature = await connection.requestAirdrop(
    payer.publicKey,
    AIRDROP_AMOUNT
  );
  await connection.confirmTransaction(signature);
  console.log("[Setup] Test environment initialized");

  return { connection, payer };
}

/**
 * Test valid signatures case
 */
async function testValidSignatures(
  connection: Connection,
  payer: Keypair
): Promise<void> {
  console.log("[Test] Starting valid signatures test");

  const { privateKey: privateKeyA } = generateRandomWallet();
  const { privateKey: privateKeyB } = generateRandomWallet();

  const instruction =
    BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction([
      { privateKey: privateKeyA, message: TEST_MESSAGES.first },
      { privateKey: privateKeyB, message: TEST_MESSAGES.second },
    ]);

  console.log(BatchSecp256k1Signer.parseBuffer(instruction.data));

  try {
    const transaction = new Transaction().add(instruction);
    const txSignature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [payer],
      TX_OPTIONS
    );

    console.log("[Success] Valid signatures test passed");
    console.log("[Info] Transaction signature:", txSignature);
  } catch (error) {
    console.log(error);
    console.log("[Error] Valid signatures test failed:", error.message);
    throw error;
  }
}

async function testInvalidSignature(
  connection: Connection,
  payer: Keypair
): Promise<void> {
  console.log("[Test] Starting invalid signature test");

  const { privateKey, wallet } = generateRandomWallet();
  const { signature, recoveryId } = BatchSecp256k1Signer.sign(
    TEST_MESSAGES.first,
    privateKey
  );

  // Corrupt the signature
  const invalidSignature = Buffer.from(signature);
  [23, 24, 26].forEach((index) => (invalidSignature[index] ^= 0xff));

  const instruction = BatchSecp256k1Signer.createVerifySignaturesInstruction([
    {
      ethAddress: wallet.address,
      message: TEST_MESSAGES.first,
      signature: invalidSignature,
      recoveryId,
    },
  ]);

  try {
    const transaction = new Transaction().add(instruction);
    await sendAndConfirmTransaction(
      connection,
      transaction,
      [payer],
      TX_OPTIONS
    );

    console.log("[Error] Invalid signature test unexpectedly passed");
    throw new Error("Transaction with invalid signature should have failed");
  } catch (error) {
    console.log("[Success] Invalid signature test failed as expected");
    console.log("[Info] Error message:", error.message);
  }
}

async function testMultipleSignatures(
  connection: Connection,
  payer: Keypair
): Promise<void> {
  console.log("[Test] Starting multiple signatures test");

  const wallets = Array.from({ length: 3 }, () => generateRandomWallet());
  const messages = [
    Buffer.from("message1"),
    Buffer.from("message2"),
    Buffer.from("message3"),
  ];

  const instruction =
    BatchSecp256k1Signer.signAndCreateVerifySignaturesInstruction(
      wallets.map((wallet, i) => ({
        privateKey: wallet.privateKey,
        message: messages[i],
      }))
    );

  try {
    const transaction = new Transaction().add(instruction);
    const txSignature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [payer],
      TX_OPTIONS
    );

    console.log("[Success] Multiple signatures test passed");
    console.log("[Info] Transaction signature:", txSignature);
  } catch (error) {
    console.log("[Error] Multiple signatures test failed:", error.message);
    throw error;
  }
}

async function main() {
  try {
    console.log("[Main] Starting test suite");
    const { connection, payer } = await initializeTestEnvironment();

    await testValidSignatures(connection, payer);
    await testInvalidSignature(connection, payer);
    await testMultipleSignatures(connection, payer);

    console.log("[Main] Test suite completed successfully");
  } catch (error) {
    console.log("[Error] Test suite failed:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
