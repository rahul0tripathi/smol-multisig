import { Buffer } from "buffer";
import {
  PublicKey,
  TransactionInstruction,
  Keypair,
  Connection,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

const Ed25519SigVerifyProgramID = new PublicKey(
  "Ed25519SigVerify111111111111111111111111111"
);

const MaxU16 = 0xffff;
const PUBLIC_KEY_BYTES = 32; // length of Ed25519 signer public key
const SIGNATURE_BYTES = 64; // length of Ed25519 signature
const SIGNATURE_OFFSETS_START = 2; // signature offset which is the first offset written in data and is after numSignatures and padding
const OFFSETS_SIZE = 14; // there are total 7 u16 header items for each signature

const formatHex = (data: Buffer, length: number = data.length) =>
  Array.from(data.subarray(0, length))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

export type Ed25519SignatureVerifyParams = {
  publicKey: Uint8Array;
  message: Uint8Array;
  signature: Uint8Array;
};

export type Ed25519SignAndVerifyParams = {
  signer: Keypair;
  message: Uint8Array;
};

export class BatchEd25519Signer {
  static sign(
    message: Parameters<typeof ed25519.sign>[0],
    secretKey: Uint8Array
  ): Uint8Array {
    return ed25519.sign(message, secretKey.slice(0, 32));
  }

  static createVerifySignaturesInstruction(
    params: Ed25519SignatureVerifyParams[]
  ): TransactionInstruction {
    /*
    the Ed25519SigVerify instruction data is made up of [count][offset metadata][actual data] 
    
    count[
        N (number of signatures)
        padding (added to make everything header 2-byte)
    ]
    offset metadata[ 
        signature1 offset
        signature1 ix index 
        (the program can read values from other instructions in the same tx, but set it to u16::MAX which indicates use the data from same ix)
        pubkey1 offset
        pubkey1 ix index
        message1 offset
        message1 size
        message1 ix index 
        ...
        ...
        signatureN offset
        signatureN ix index 
        pubkeyN offset
        pubkeyN ix index
        messageN offset
        messageN size
        messageN ix index
    ]
    data[
        signature1
        pubkey1
        message1
        ...
        ...
        signatureN
        pubkeyN
        messageN
    ]
    */

    // num + padding + offsets
    const headerSize = SIGNATURE_OFFSETS_START + OFFSETS_SIZE * params.length;

    const dataStart = headerSize;

    // the actual data
    const signaturesSize = params.length * SIGNATURE_BYTES;
    const publicKeysSize = params.length * PUBLIC_KEY_BYTES;
    const messagesSize = params.reduce((sum, p) => sum + p.message.length, 0);

    const totalSize = headerSize + signaturesSize + publicKeysSize + messagesSize
    // allocate buffer
    const instructionData = Buffer.alloc(
      totalSize
    );

    // write total count
    instructionData.writeUInt8(params.length, 0);
    // add padding
    instructionData.writeUInt8(0, 1);

    let currentSignatureOffset = dataStart;
    let currentPubkeyOffset = currentSignatureOffset + signaturesSize;
    let currentMessageOffset = currentPubkeyOffset + publicKeysSize;

    let headerOffset = SIGNATURE_OFFSETS_START;
    for (let i = 0; i < params.length; i++) {
      // signature offset
      instructionData.writeUInt16LE(currentSignatureOffset, headerOffset);
      headerOffset += 2;
      // signature ix index
      instructionData.writeUInt16LE(MaxU16, headerOffset);
      headerOffset += 2;
      // pubkey offset
      instructionData.writeUInt16LE(currentPubkeyOffset, headerOffset);
      headerOffset += 2;
      // pubkey ix index
      instructionData.writeUInt16LE(MaxU16, headerOffset);
      headerOffset += 2;
      // message offset
      instructionData.writeUInt16LE(currentMessageOffset, headerOffset);
      headerOffset += 2;
      // message size
      instructionData.writeUInt16LE(params[i].message.length, headerOffset);
      headerOffset += 2;
      // message ix index
      instructionData.writeUInt16LE(MaxU16, headerOffset);
      headerOffset += 2;

      // shift all offsets for next iteration
      currentSignatureOffset += SIGNATURE_BYTES;
      currentPubkeyOffset += PUBLIC_KEY_BYTES;
      currentMessageOffset += params[i].message.length;
    }

    // start writing data
    const startingSignatureOffset = dataStart;
    const startingPubkeyOffset = dataStart + signaturesSize;
    const startingMessageOffset = startingPubkeyOffset + publicKeysSize;

    let sigOffset = startingSignatureOffset;
    let pubOffset = startingPubkeyOffset;
    let msgOffset = startingMessageOffset;

    for (const { signature, publicKey, message } of params) {
      instructionData.set(signature, sigOffset);
      instructionData.set(publicKey, pubOffset);
      instructionData.set(message, msgOffset);

      sigOffset += SIGNATURE_BYTES;
      pubOffset += PUBLIC_KEY_BYTES;
      msgOffset += message.length;
    }

    return new TransactionInstruction({
      keys: [],
      programId: Ed25519SigVerifyProgramID,
      data: instructionData,
    });
  }

  static signAndCreateVerifySignaturesInstruction(
    params: Ed25519SignAndVerifyParams[]
  ): TransactionInstruction {
    const paramsWithSignature: Ed25519SignatureVerifyParams[] = [];
    for (let item of params) {
      paramsWithSignature.push({
        signature: BatchEd25519Signer.sign(
          item.message,
          item.signer.secretKey
        ),
        publicKey: item.signer.publicKey.toBuffer(),
        message: item.message,
      });
    }

    return BatchEd25519Signer.createVerifySignaturesInstruction(
      paramsWithSignature
    );
  }

  static parseBuffer(buffer: Buffer): Object {
    let result = {
      numSignatures: 0,
      padding: 0,
      remainingHeaders: [],
      data: [],
    };
    const numSignatures = buffer.readUInt8(0);

    result.numSignatures = buffer.readUInt8(0);
    result.padding = buffer.readUInt8(1);

    // Read all headers first
    const headers = [];
    for (let i = 0; i < numSignatures; i++) {
      const base = SIGNATURE_OFFSETS_START + i * OFFSETS_SIZE;
      headers.push({
        sigOffset: buffer.readUInt16LE(base),
        sigInstIdx: buffer.readUInt16LE(base + 2),
        pubOffset: buffer.readUInt16LE(base + 4),
        pubInstIdx: buffer.readUInt16LE(base + 6),
        msgOffset: buffer.readUInt16LE(base + 8),
        msgSize: buffer.readUInt16LE(base + 10),
        msgInstIdx: buffer.readUInt16LE(base + 12),
      });
    }

    result.remainingHeaders = headers;

    result.data= headers.reduce((data, header) => {
      data.push({
        signature: formatHex(
          buffer.subarray(header.sigOffset, header.sigOffset + SIGNATURE_BYTES)
        ),
        publicKey: formatHex(
          buffer.subarray(header.pubOffset, header.pubOffset + PUBLIC_KEY_BYTES)
        ),
        messageHex: formatHex(
          buffer.subarray(header.msgOffset, header.msgOffset + header.msgSize)
        ),
        message: buffer
          .subarray(header.msgOffset, header.msgOffset + header.msgSize)
          .toString("utf8"),
      });

      return data
    }, []);

    return result;
  }
}
