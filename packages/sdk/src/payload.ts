import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { Point } from "@ctd/sdk";
import type {
  RevokeSpenderWitness,
  SetSpenderWitness,
  SpenderTransferWitness,
} from "./spender.js";
import type { QuietBookRegisterWitness } from "./register.js";

const bytes = (value: Uint8Array): xdr.ScVal => nativeToScVal(value, { type: "bytes" });

function toBytes32BE(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new RangeError("value outside 256-bit range");
  const encoded = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return encoded;
}

function pointToBytes(value: Point): Uint8Array {
  const encoded = new Uint8Array(64);
  if (value.is0()) return encoded;
  const { x, y } = value.toAffine();
  encoded.set(toBytes32BE(x), 0);
  encoded.set(toBytes32BE(y), 32);
  return encoded;
}

const point = (value: Point): xdr.ScVal => bytes(pointToBytes(value));
const field = (value: bigint): xdr.ScVal => bytes(toBytes32BE(value));

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key]! })),
  );
}

function envelope(payload: xdr.ScVal, proof: Uint8Array): xdr.ScVal {
  return bytes(struct({ payload, proof: bytes(proof) }).toXDR());
}

function escrowedDvk(value: { rX: bigint; cipher: bigint }): xdr.ScVal {
  const encoded = new Uint8Array(64);
  encoded.set(toBytes32BE(value.rX), 0);
  encoded.set(toBytes32BE(value.cipher), 32);
  return bytes(encoded);
}

export function encodeRegisterData(witness: QuietBookRegisterWitness, proof: Uint8Array): xdr.ScVal {
  return envelope(
    struct({
      pvk: point(witness.payload.pvk),
      y: point(witness.payload.y),
    }),
    proof,
  );
}

export function encodeSetSpenderData(witness: SetSpenderWitness, proof: Uint8Array): xdr.ScVal {
  const p = witness.payload;
  return envelope(
    struct({
      a_tilde: field(p.aTilde),
      b_tilde: field(p.bTilde),
      b_tilde_aud_s: field(p.bAudS),
      c_a: point(p.cA),
      c_spend_new: point(p.cSpendNew),
      escrowed_dvk: escrowedDvk(p.escrowedDvk),
      r_e_point: point(p.rE),
      sigma: field(p.sigma),
      sigma_a: field(p.sigmaA),
      v_tilde_aud_s: field(p.vAudS),
    }),
    proof,
  );
}

export function encodeSpenderTransferData(
  witness: SpenderTransferWitness,
  proof: Uint8Array,
): xdr.ScVal {
  const p = witness.payload;
  return envelope(
    struct({
      a_tilde_aud_s: field(p.aAudS),
      a_tilde_new: field(p.aTildeNew),
      c_a_new: point(p.cANew),
      c_transfer: point(p.cTransfer),
      r_e_point: point(p.rE),
      r_tilde_aud_r: field(p.rAudR),
      sigma_a_new: field(p.sigmaANew),
      v_tilde: field(p.vTilde),
      v_tilde_aud_r: field(p.vAudR),
      v_tilde_aud_s: field(p.vAudS),
    }),
    proof,
  );
}

export function encodeRevokeSpenderData(
  witness: RevokeSpenderWitness,
  proof: Uint8Array,
): xdr.ScVal {
  const p = witness.payload;
  return envelope(
    struct({
      b_tilde: field(p.bTilde),
      b_tilde_aud_s: field(p.bAudS),
      c_spend_new: point(p.cSpendNew),
      r_e_point: point(p.rE),
      sigma: field(p.sigma),
      v_tilde_aud_s: field(p.vAudS),
    }),
    proof,
  );
}
