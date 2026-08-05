import { scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  DOMAIN,
  frMod,
  fromBytesBE,
  pointCoords,
  pointFromBytes,
  poseidonWithDomain,
  scalarMul,
  spongeSqueeze2,
  type Point,
} from "@ctd/sdk";

const ECDH_SHARED_SECRET_DOMAIN = 13n;
type EventBase = { ledger: number; txHash: string; eventId: string };

export type AllowanceAuditEvent = EventBase & {
  type: "set_spender" | "revoke_spender";
  account: string;
  spender: string;
  liveUntilLedger?: number;
  rE: Point;
  sigma: bigint;
  vAudS: bigint;
  bAudS: bigint;
};

export type SpenderTransferAuditEvent = EventBase & {
  type: "spender_transfer";
  spender: string;
  from: string;
  to: string;
  rE: Point;
  sigmaA: bigint;
  vTilde: bigint;
  vAudR: bigint;
  rAudR: bigint;
  vAudS: bigint;
  aAudS: bigint;
};

export type QuietBookAuditEvent = AllowanceAuditEvent | SpenderTransferAuditEvent;
type RawEventXdr = { topic: string[]; value: string };

function dataFields(value: xdr.ScVal): Map<string, xdr.ScVal> {
  const entries = value.map();
  if (!entries) throw new Error("auditor event data is not a map");
  return new Map(entries.map((entry) => [entry.key().sym().toString(), entry.val()]));
}

function required(fields: Map<string, xdr.ScVal>, name: string): xdr.ScVal {
  const value = fields.get(name);
  if (!value) throw new Error(`auditor event is missing ${name}`);
  return value;
}

function field(fields: Map<string, xdr.ScVal>, name: string): bigint {
  return fromBytesBE(new Uint8Array(required(fields, name).bytes()));
}

function point(fields: Map<string, xdr.ScVal>, name: string): Point {
  return pointFromBytes(new Uint8Array(required(fields, name).bytes()));
}

function address(topics: xdr.ScVal[], index: number): string {
  const value = topics[index];
  if (!value) throw new Error(`auditor event is missing topic ${index}`);
  return String(scValToNative(value));
}

export function parseAuditEvent(rawXdr: string, base: EventBase): QuietBookAuditEvent {
  const raw = JSON.parse(rawXdr) as RawEventXdr;
  const topics = raw.topic.map((item) => xdr.ScVal.fromXDR(item, "base64"));
  const fields = dataFields(xdr.ScVal.fromXDR(raw.value, "base64"));
  const name = topics[0]?.sym().toString();
  if (name === "set_spender" || name === "revoke_spender") {
    return {
      ...base,
      type: name,
      account: address(topics, 1),
      spender: address(topics, 2),
      ...(name === "set_spender" ? { liveUntilLedger: required(fields, "live_until_ledger").u32() } : {}),
      rE: point(fields, "r_e_point"),
      sigma: field(fields, "sigma"),
      vAudS: field(fields, "v_tilde_aud_s"),
      bAudS: field(fields, "b_tilde_aud_s"),
    };
  }
  if (name === "spender_transfer") {
    return {
      ...base,
      type: name,
      spender: address(topics, 1),
      from: address(topics, 2),
      to: address(topics, 3),
      rE: point(fields, "r_e_point"),
      sigmaA: field(fields, "sigma_a"),
      vTilde: field(fields, "v_tilde"),
      vAudR: field(fields, "v_tilde_aud_r"),
      rAudR: field(fields, "r_tilde_aud_r"),
      vAudS: field(fields, "v_tilde_aud_s"),
      aAudS: field(fields, "a_tilde_aud_s"),
    };
  }
  throw new Error(`unsupported auditor event ${name ?? "unknown"}`);
}

function sharedSecret(secret: bigint, rE: Point): bigint {
  const shared = scalarMul(secret, rE);
  if (shared.is0()) throw new Error("auditor ECDH produced the identity");
  const { x, y } = pointCoords(shared);
  return poseidonWithDomain(ECDH_SHARED_SECRET_DOMAIN, [x, y]);
}

const decrypt = (ciphertext: bigint, mask: bigint) => frMod(ciphertext - mask);

export function decryptAllowanceEvent(secret: bigint, event: AllowanceAuditEvent) {
  const [amountMask, balanceMask] = spongeSqueeze2(
    DOMAIN.AUDITOR_SENDER,
    sharedSecret(secret, event.rE),
    event.sigma,
  );
  return {
    allowance: decrypt(event.vAudS, amountMask),
    ownerPostBalance: decrypt(event.bAudS, balanceMask),
  };
}

export function decryptSpenderTransferEvent(secret: bigint, event: SpenderTransferAuditEvent) {
  const shared = sharedSecret(secret, event.rE);
  const [senderAmountMask, allowanceMask] = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, shared, event.sigmaA);
  const [recipientAmountMask, randomnessMask] = spongeSqueeze2(DOMAIN.AUDITOR_RECIPIENT, shared, event.sigmaA);
  const senderAmount = decrypt(event.vAudS, senderAmountMask);
  const recipientAmount = decrypt(event.vAudR, recipientAmountMask);
  return {
    amount: senderAmount,
    recipientAmount,
    remainingAllowance: decrypt(event.aAudS, allowanceMask),
    transferRandomness: decrypt(event.rAudR, randomnessMask),
    channelsAgree: senderAmount === recipientAmount,
  };
}
