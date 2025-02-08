import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BatchEd25519Signer } from "../utils/ed25519";

// Constants
const RPC_URL = "http://localhost:8899";
const AIRDROP_AMOUNT = 1_000_000_000; // 1 SOL
const TX_OPTIONS = {
  commitment: "confirmed" as const,
  maxRetries: 5,
};

// Test Messages
const TEST_MESSAGES = {
  first: Buffer.from("hello-world"),
  second: Buffer.from("hello-world-second"),
};

/**
 * Initialize Solana connection and fund the payer account
 */
async function initializeTestEnvironment(): Promise<{
  connection: Connection;
  payer: Keypair;
}> {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.generate();

  console.log("[Setup] Initializing test environment");
  const signature = await connection.requestAirdrop(payer.publicKey, AIRDROP_AMOUNT);
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

  const signer = Keypair.generate();
  const signerB = Keypair.generate();

  const instruction = BatchEd25519Signer.signAndCreateVerifySignaturesInstruction([
    { signer, message: TEST_MESSAGES.first },
    { signer: signerB, message: TEST_MESSAGES.second },
  ]);

  console.log("[Debug] Valid case buffer:");
  console.log(BatchEd25519Signer.parseBuffer(instruction.data));

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
    console.log("[Error] Valid signatures test failed:", error.message);
    throw error;
  }
}

/**
 * Test invalid signature case
 */
async function testInvalidSignature(
  connection: Connection,
  payer: Keypair
): Promise<void> {
  console.log("[Test] Starting invalid signature test");

  const signer = Keypair.generate();
  const validSignature = BatchEd25519Signer.sign(TEST_MESSAGES.first, signer.secretKey);
  
  // Corrupt the signature
  const invalidSignature = new Uint8Array(validSignature);
  [23, 24, 26].forEach(index => invalidSignature[index] ^= 0xff);

  const instruction = BatchEd25519Signer.createVerifySignaturesInstruction([
    {
      publicKey: signer.publicKey.toBytes(),
      message: TEST_MESSAGES.first,
      signature: invalidSignature,
    },
  ]);

  console.log("[Debug] Invalid case buffer:");
  console.log(BatchEd25519Signer.parseBuffer(instruction.data));

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

/**
 * Main test runner
 */
async function main() {
  try {
    console.log("[Main] Starting test suite");
    const { connection, payer } = await initializeTestEnvironment();

    await testValidSignatures(connection, payer);
    await testInvalidSignature(connection, payer);
    
    console.log("[Main] Test suite completed successfully");
  } catch (error) {
    console.log("[Error] Test suite failed:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}