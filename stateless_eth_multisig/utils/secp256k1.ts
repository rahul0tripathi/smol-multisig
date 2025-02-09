import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Wallet, SigningKey, getAddress } from "ethers";
import { keccak_256 } from "@noble/hashes/sha3";

const Secp256k1SigVerifyProgramID = new PublicKey(
  "KeccakSecp256k11111111111111111111111111111"
);

// Constants based on Secp256k1SignatureOffsets struct
const SIGNATURE_LENGTH = 64;
const RECOVERY_ID_LENGTH = 1;
const ETH_ADDRESS_LENGTH = 20;
const SIGNATURE_OFFSETS_LENGTH = 11; // size of Secp256k1SignatureOffsets struct
const DATA_START = 1; // first byte is number of signatures

const formatHex = (data: Buffer, length: number = data.length) =>
  Array.from(data.subarray(0, length))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

export type Secp256k1SignatureVerifyParams = {
  ethAddress: string | Uint8Array;
  message: Uint8Array;
  signature: Uint8Array;
  recoveryId: number;
};

export type Secp256k1SignAndVerifyParams = {
  privateKey: Uint8Array;
  message: Uint8Array;
};

export class BatchSecp256k1Signer {
  static sign(
    message: Uint8Array,
    privateKey: Uint8Array
  ): { signature: Buffer; recoveryId: number } {
    const signingKey = new SigningKey(privateKey);

    const messageHash = Buffer.from(keccak_256(Buffer.from(message)));
    const sig = signingKey.sign(messageHash);

    // concat r and s and give v explicity in recoveryId
    const flatSig = Buffer.concat([
      // remove 0x and concat
      Buffer.from(sig.r.slice(2), "hex"),
      Buffer.from(sig.s.slice(2), "hex"),
    ]);

    return {
      signature: flatSig,
      recoveryId: sig.yParity,
    };
  }

  static createVerifySignaturesInstruction(
    params: Secp256k1SignatureVerifyParams[]
  ): TransactionInstruction {
    /*
    the Secp256k1SigVerify instruction data is made up of [count][offset metadata][actual data] 
    
    count[
        N (number of signatures)
    ]
    offset metadata[ 
        signature1 offset
        signature1 ix index 
        (the program can read values from other instructions in the same tx)
        pubkey1 offset (it's the ethereum address)
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
        pubkey1
        ...
        pubkeyN
        signature1 + recoveryId1
        ...
        signatureN + recoveryId1
        message1
        ...
        messageN
    ]
    */
    const offsetsLength = params.length * SIGNATURE_OFFSETS_LENGTH;
    const dataStart = DATA_START + offsetsLength;

    const totalSignatureSize = SIGNATURE_LENGTH + RECOVERY_ID_LENGTH;
    const signaturesSize = params.length * totalSignatureSize;
    const addressesSize = params.length * ETH_ADDRESS_LENGTH;
    const messagesSize = params.reduce((sum, p) => sum + p.message.length, 0);

    const instructionData = Buffer.alloc(
      dataStart + addressesSize + signaturesSize + messagesSize
    );

    instructionData.writeUInt8(params.length, 0);

    let currentAddressOffset = dataStart;
    let currentSignatureOffset = currentAddressOffset + addressesSize;
    let currentMessageOffset = currentSignatureOffset + signaturesSize;

    params.forEach((param, i) => {
      const headerStart = DATA_START + i * SIGNATURE_OFFSETS_LENGTH;

      instructionData.writeUInt16LE(currentSignatureOffset, headerStart);
      instructionData.writeUInt8(0, headerStart + 2);

      instructionData.writeUInt16LE(currentAddressOffset, headerStart + 3);
      instructionData.writeUInt8(0, headerStart + 5);

      instructionData.writeUInt16LE(currentMessageOffset, headerStart + 6);
      instructionData.writeUInt16LE(param.message.length, headerStart + 8);
      instructionData.writeUInt8(0, headerStart + 10);

      let ethAddress: Buffer;
      if (typeof param.ethAddress === "string") {
        const normalizedAddr = getAddress(param.ethAddress);
        ethAddress = Buffer.from(normalizedAddr.slice(2), "hex");
      } else {
        ethAddress = Buffer.from(param.ethAddress);
      }
      instructionData.set(ethAddress, currentAddressOffset);
      currentAddressOffset += ETH_ADDRESS_LENGTH;

      instructionData.set(param.signature, currentSignatureOffset);
      instructionData.writeUInt8(
        param.recoveryId,
        currentSignatureOffset + SIGNATURE_LENGTH
      );
      currentSignatureOffset += SIGNATURE_LENGTH + RECOVERY_ID_LENGTH;

      instructionData.set(param.message, currentMessageOffset);
      currentMessageOffset += param.message.length;
    });

    return new TransactionInstruction({
      keys: [],
      programId: Secp256k1SigVerifyProgramID,
      data: instructionData,
    });
  }

  static signAndCreateVerifySignaturesInstruction(
    params: Secp256k1SignAndVerifyParams[]
  ): TransactionInstruction {
    const paramsWithSignature: Secp256k1SignatureVerifyParams[] = [];

    for (const item of params) {
      const wallet = new Wallet(new SigningKey(item.privateKey));
      const { signature, recoveryId } = BatchSecp256k1Signer.sign(
        item.message,
        item.privateKey
      );

      paramsWithSignature.push({
        signature,
        recoveryId,
        ethAddress: wallet.address,
        message: item.message,
      });
    }

    return BatchSecp256k1Signer.createVerifySignaturesInstruction(
      paramsWithSignature
    );
  }

  static parseBuffer(buffer: Buffer): Object {
    const result = {
      numSignatures: 0,
      remainingHeaders: [],
      data: [],
    };

    const numSignatures = buffer.readUInt8(0);
    result.numSignatures = numSignatures;

    // Read headers
    const headers = [];
    for (let i = 0; i < numSignatures; i++) {
      const base = DATA_START + i * SIGNATURE_OFFSETS_LENGTH;
      headers.push({
        secp_signature_offset: buffer.readUInt16LE(base),
        secp_signature_instruction_index: buffer.readUInt8(base + 2),
        secp_pubkey_offset: buffer.readUInt16LE(base + 3),
        secp_pubkey_instruction_index: buffer.readUInt8(base + 5),
        secp_message_data_offset: buffer.readUInt16LE(base + 6),
        secp_message_data_size: buffer.readUInt16LE(base + 8),
        secp_message_instruction_index: buffer.readUInt8(base + 10),
      });
    }

    result.remainingHeaders = headers;

    // parse each signature's data
    result.data = headers.map((header) => {
      const signatureEnd = header.secp_signature_offset + SIGNATURE_LENGTH;
      return {
        signature: formatHex(
          buffer.subarray(header.secp_signature_offset, signatureEnd)
        ),
        recoveryId: buffer.readUInt8(signatureEnd),
        ethAddress: formatHex(
          buffer.subarray(
            header.secp_pubkey_offset,
            header.secp_pubkey_offset + ETH_ADDRESS_LENGTH
          )
        ),
        messageHex: formatHex(
          buffer.subarray(
            header.secp_message_data_offset,
            header.secp_message_data_offset + header.secp_message_data_size
          )
        ),
        message: buffer
          .subarray(
            header.secp_message_data_offset,
            header.secp_message_data_offset + header.secp_message_data_size
          )
          .toString("utf8"),
      };
    });

    return result;
  }
}
