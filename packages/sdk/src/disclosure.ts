import {
  DOMAIN,
  H,
  Grumpkin,
  frMod,
  pointCoords,
  poseidonWithDomain,
  randomScalar,
  scalarMul,
  toHex32,
  type KeyPair,
  type NoirInputs,
  type Point,
} from "@ctd/sdk";
import type { SpenderTransferAuditEvent } from "./audit.js";

const ECDH_SHARED_SECRET_DOMAIN = 13n;
const SETTLEMENT_DISCLOSURE_DOMAIN = 14n;
const MAX_I128 = 1n << 127n;

export type JsonPoint = { x: string; y: string };
export type SettlementDisclosureRecipient = { secret: bigint; publicKey: JsonPoint };
export type SettlementDisclosureRequest = { recipientPublicKey: JsonPoint; nonce: string };

export type SettlementDisclosureWitness = {
  inputs: NoirInputs;
  amount: bigint;
  rDisc: Point;
  vTildeDisc: bigint;
};

function currentEcdh(scalar: bigint, point: Point): bigint {
  const shared = scalarMul(scalar, point);
  if (shared.is0()) throw new Error("disclosure ECDH produced the identity");
  const { x, y } = pointCoords(shared);
  return poseidonWithDomain(ECDH_SHARED_SECRET_DOMAIN, [x, y]);
}

function fromHex(value: string): bigint {
  return BigInt(value.startsWith("0x") ? value : `0x${value}`);
}

export function pointToJson(point: Point): JsonPoint {
  const { x, y } = pointCoords(point);
  return { x: toHex32(x), y: toHex32(y) };
}

export function pointFromJson(point: JsonPoint): Point {
  return Grumpkin.fromAffine({ x: fromHex(point.x), y: fromHex(point.y) });
}

export function generateSettlementDisclosureRecipient(): SettlementDisclosureRecipient {
  const secret = randomScalar();
  return { secret, publicKey: pointToJson(scalarMul(secret, H)) };
}

export function createSettlementDisclosureRequest(
  recipient: SettlementDisclosureRecipient,
  nonce = randomScalar(),
): SettlementDisclosureRequest {
  return { recipientPublicKey: recipient.publicKey, nonce: toHex32(nonce) };
}

export function buildSettlementDisclosureWitness(params: {
  holderKeys: KeyPair;
  event: SpenderTransferAuditEvent;
  request: SettlementDisclosureRequest;
  rDisc?: bigint;
}): SettlementDisclosureWitness {
  const { holderKeys, event, request } = params;
  const eventShared = currentEcdh(holderKeys.vk, event.rE);
  const amount = frMod(
    event.vTilde - poseidonWithDomain(DOMAIN.TX_AMOUNT, [eventShared, event.sigmaA]),
  );
  if (amount >= MAX_I128) throw new Error("event does not decrypt for this settlement recipient");

  const rDiscScalar = params.rDisc ?? randomScalar();
  const rDisc = scalarMul(rDiscScalar, H);
  const recipientKey = pointFromJson(request.recipientPublicKey);
  const disclosureShared = currentEcdh(rDiscScalar, recipientKey);
  const nonce = fromHex(request.nonce);
  const vTildeDisc = frMod(
    amount + poseidonWithDomain(SETTLEMENT_DISCLOSURE_DOMAIN, [disclosureShared, nonce]),
  );
  const rE = pointCoords(event.rE);
  const pvk = pointCoords(holderKeys.PVK);
  const pR = pointCoords(recipientKey);
  const rD = pointCoords(rDisc);
  const field = (value: bigint) => toHex32(value);
  return {
    amount,
    rDisc,
    vTildeDisc,
    inputs: {
      sk: field(holderKeys.sk),
      v_tx: field(amount),
      r_disc: field(rDiscScalar),
      addr_f: field(holderKeys.addrF),
      pvk_a_x: field(pvk.x),
      pvk_a_y: field(pvk.y),
      r_e_x: field(rE.x),
      r_e_y: field(rE.y),
      sigma: field(event.sigmaA),
      v_tilde: field(event.vTilde),
      p_r_x: field(pR.x),
      p_r_y: field(pR.y),
      nu: field(nonce),
      r_disc_x: field(rD.x),
      r_disc_y: field(rD.y),
      v_tilde_disc: field(vTildeDisc),
    },
  };
}

export function settlementDisclosurePublicInputs(params: {
  addressField: bigint;
  holderViewingPublicKey: Point;
  event: SpenderTransferAuditEvent;
  request: SettlementDisclosureRequest;
  rDisc: JsonPoint;
  vTildeDisc: string;
}): string[] {
  const pvk = pointCoords(params.holderViewingPublicKey);
  const rE = pointCoords(params.event.rE);
  return [
    params.addressField,
    pvk.x,
    pvk.y,
    rE.x,
    rE.y,
    params.event.sigmaA,
    params.event.vTilde,
    fromHex(params.request.recipientPublicKey.x),
    fromHex(params.request.recipientPublicKey.y),
    fromHex(params.request.nonce),
    fromHex(params.rDisc.x),
    fromHex(params.rDisc.y),
    fromHex(params.vTildeDisc),
  ].map(toHex32);
}

export function decryptSettlementDisclosure(params: {
  recipientSecret: bigint;
  request: SettlementDisclosureRequest;
  rDisc: JsonPoint;
  vTildeDisc: string;
}): bigint {
  const shared = currentEcdh(params.recipientSecret, pointFromJson(params.rDisc));
  return frMod(
    fromHex(params.vTildeDisc) - poseidonWithDomain(
      SETTLEMENT_DISCLOSURE_DOMAIN,
      [shared, fromHex(params.request.nonce)],
    ),
  );
}
