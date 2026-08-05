import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { H, proverFromArtifact, scalarMul, toHex32 } from "@ctd/sdk";
import {
  buildSettlementDisclosureWitness,
  createSettlementDisclosureRequest,
  pointToJson,
} from "../src/index.js";
import { buildFixture } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const circuits = join(here, "..", "circuits");
const fixture = buildFixture();

async function prove(name: string, inputs: Record<string, string>, expectedPublicInputs = 24): Promise<void> {
  const artifact = JSON.parse(readFileSync(join(circuits, `${name}.json`), "utf8"));
  const prover = proverFromArtifact(artifact);
  try {
    const result = await prover.prove(inputs);
    assert.equal(result.publicInputs.length, expectedPublicInputs);
    assert.equal(await prover.verify(result), true);
    console.log(`${name}: ${result.proof.length} byte proof verified`);
  } finally {
    await prover.destroy();
  }
}

await prove("set_spender", fixture.setSpender.inputs);
await prove("revoke_spender", fixture.revokeSpender.inputs, 19);
await prove("spender_transfer", fixture.spenderTransfer.inputs);
await prove("max_bid", fixture.maxBid.inputs, 14);

const disclosureRecipient = {
  secret: 0x123456n,
  publicKey: pointToJson(scalarMul(0x123456n, H)),
};
const disclosureRequest = createSettlementDisclosureRequest(disclosureRecipient, 0x789abcn);
const disclosureEvent = {
  type: "spender_transfer" as const,
  eventId: "local-disclosure-event",
  ledger: 1,
  txHash: "ab".repeat(32),
  spender: "CSPENDER",
  from: "GOWNER",
  to: "GISSUER",
  rE: fixture.spenderTransfer.payload.rE,
  sigmaA: fixture.setSpender.delegation.sigmaA,
  vTilde: fixture.spenderTransfer.payload.vTilde,
  vAudR: fixture.spenderTransfer.payload.vAudR,
  rAudR: fixture.spenderTransfer.payload.rAudR,
  vAudS: fixture.spenderTransfer.payload.vAudS,
  aAudS: fixture.spenderTransfer.payload.aAudS,
};
const disclosure = buildSettlementDisclosureWitness({
  holderKeys: fixture.recipientKeys,
  event: disclosureEvent,
  request: disclosureRequest,
  rDisc: 0xdef123n,
});
const disclosureArtifact = JSON.parse(readFileSync(join(circuits, "disclose_settlement.json"), "utf8"));
const disclosureProver = proverFromArtifact(disclosureArtifact);
try {
  const result = await disclosureProver.prove(disclosure.inputs);
  assert.equal(result.publicInputs.length, 13);
  assert.equal(await disclosureProver.verify(result), true);
  const tamperedNonce = [...result.publicInputs];
  tamperedNonce[9] = toHex32(BigInt(tamperedNonce[9]!) + 1n);
  assert.equal(await disclosureProver.verify({ ...result, publicInputs: tamperedNonce }), false);
  const pinned = readFileSync(join(circuits, "vks", "disclose_settlement.vk.bin"));
  assert.deepEqual(Buffer.from(await disclosureProver.verificationKey()), pinned);
  console.log(`disclose_settlement: ${result.proof.length} byte recipient-bound proof verified`);
} finally {
  await disclosureProver.destroy();
}
