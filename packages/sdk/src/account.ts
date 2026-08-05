import { scValToNative, type xdr } from "@stellar/stellar-sdk";

export type ConfidentialAccountSnapshot = {
  auditorId: number;
  spendableCommitment: Uint8Array;
  receivingCommitment: Uint8Array;
  spendingPublicKey: Uint8Array;
  viewingPublicKey: Uint8Array;
};

type NativeAccount = Record<string, unknown>;

function bytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`confidential account ${field} is not bytes`);
  return value;
}

/** Parse the current OpenZeppelin confidential-account schema without relying on the stale reference SDK keys. */
export function parseConfidentialAccount(value: xdr.ScVal): ConfidentialAccountSnapshot {
  const native = scValToNative(value) as NativeAccount;
  if (typeof native.auditor_id !== "number") {
    throw new Error("confidential account auditor_id is not a number");
  }
  return {
    auditorId: native.auditor_id,
    spendableCommitment: bytes(native.spendable_commitment, "spendable_commitment"),
    receivingCommitment: bytes(native.receiving_commitment, "receiving_commitment"),
    spendingPublicKey: bytes(native.spending_public_key, "spending_public_key"),
    viewingPublicKey: bytes(native.viewing_public_key, "viewing_public_key"),
  };
}
