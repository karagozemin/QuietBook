import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Address, Networks } from "@stellar/stellar-sdk";
import {
  ChainClient,
  addressToField,
  deriveKeys,
  pointFromBytes,
  proverFromArtifact,
  randomScalar,
  toHex32,
} from "@ctd/sdk";
import { parseConfidentialAccount } from "../packages/sdk/src/account.js";
import { parseAuditEvent, type SpenderTransferAuditEvent } from "../packages/sdk/src/audit.js";
import {
  buildSettlementDisclosureWitness,
  createSettlementDisclosureRequest,
  decryptSettlementDisclosure,
  generateSettlementDisclosureRecipient,
  pointToJson,
  settlementDisclosurePublicInputs,
} from "../packages/sdk/src/disclosure.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(join(root, "docs/evidence/testnet/deployment.json"), "utf8"));
const settlement = JSON.parse(readFileSync(join(root, "docs/evidence/testnet/settlement.json"), "utf8"));
const issuerPrivate = JSON.parse(readFileSync(join(root, ".quietbook/testnet-smoke-private.json"), "utf8"));
const artifactPath = join(root, "packages/sdk/circuits/disclose_settlement.json");
const vkPath = join(root, "packages/sdk/circuits/vks/disclose_settlement.vk.bin");
const vkJsonPath = join(root, "packages/sdk/circuits/vks/disclose_settlement.vk.json");
const privatePath = join(root, ".quietbook/disclosure-private.json");
const evidencePath = join(root, "docs/evidence/testnet/disclosure.json");

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const normalize = (values: string[]) => values.map((value) => toHex32(BigInt(value)));

async function main() {
  const token = deployment.contracts.confidentialToken.contractId as string;
  const db = new DatabaseSync(join(root, ".quietbook/indexer.sqlite"), { readOnly: true });
  const row = db.prepare(`
    SELECT id, ledger, tx_hash AS txHash, raw_xdr AS rawXdr
    FROM chain_events
    WHERE contract_id = ? AND tx_hash = ? AND event_type = 'spender_transfer'
  `).get(token, settlement.finalizeTransaction) as {
    id: string;
    ledger: number;
    txHash: string;
    rawXdr: string;
  } | undefined;
  db.close();
  if (!row) throw new Error("settlement spender_transfer event is not indexed");
  const event = parseAuditEvent(row.rawXdr, {
    eventId: row.id,
    ledger: row.ledger,
    txHash: row.txHash,
  }) as SpenderTransferAuditEvent;
  if (event.to !== deployment.roles.issuer || event.from !== settlement.winner) {
    throw new Error("settlement event identities do not match evidence");
  }

  const addressField = addressToField(token);
  const holderKeys = deriveKeys(BigInt(issuerPrivate.issuerConfidentialSk), addressField);
  const chain = new ChainClient({
    rpcUrl: deployment.rpcUrl,
    networkPassphrase: Networks.TESTNET,
    contracts: {
      token,
      verifier: deployment.contracts.confidentialVerifier.contractId,
      auditor: deployment.contracts.confidentialAuditor.contractId,
    },
  });
  const accountValue = await chain.simulate(token, "confidential_balance", [new Address(event.to).toScVal()]);
  const account = parseConfidentialAccount(accountValue);
  const holderViewingPublicKey = pointFromBytes(account.viewingPublicKey);
  if (!holderViewingPublicKey.equals(holderKeys.PVK)) throw new Error("issuer private key does not match on-chain PVK");

  const recipient = generateSettlementDisclosureRecipient();
  const request = createSettlementDisclosureRequest(recipient);
  const witness = buildSettlementDisclosureWitness({ holderKeys, event, request });
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const prover = proverFromArtifact(artifact);
  try {
    const generated = await prover.prove(witness.inputs);
    const rDisc = pointToJson(witness.rDisc);
    const vTildeDisc = toHex32(witness.vTildeDisc);
    const publicInputs = settlementDisclosurePublicInputs({
      addressField,
      holderViewingPublicKey,
      event,
      request,
      rDisc,
      vTildeDisc,
    });
    if (normalize(generated.publicInputs).join(":") !== normalize(publicInputs).join(":")) {
      throw new Error("disclosure prover inputs do not match independently reconstructed chain inputs");
    }
    if (!(await prover.verify({ proof: generated.proof, publicInputs }))) {
      throw new Error("settlement disclosure proof failed local verification");
    }

    const verificationKey = await prover.verificationKey();
    if (existsSync(vkPath) && !Buffer.from(readFileSync(vkPath)).equals(Buffer.from(verificationKey))) {
      throw new Error("pinned settlement disclosure verification key drifted");
    }
    writeFileSync(vkPath, verificationKey);
    writeFileSync(vkJsonPath, `${JSON.stringify({
      circuitId: "disclose_settlement",
      bytes: verificationKey.length,
      sha256: hash(verificationKey),
      base64: Buffer.from(verificationKey).toString("base64"),
    }, null, 2)}\n`);

    const wrongNonce = { ...request, nonce: toHex32(randomScalar()) };
    const wrongRecipient = createSettlementDisclosureRequest(generateSettlementDisclosureRecipient());
    const tamperedEvent = { ...event, vTilde: event.vTilde + 1n };
    const verifyVariant = (variant: { request?: typeof request; event?: typeof event }) => prover.verify({
      proof: generated.proof,
      publicInputs: settlementDisclosurePublicInputs({
        addressField,
        holderViewingPublicKey,
        event: variant.event ?? event,
        request: variant.request ?? request,
        rDisc,
        vTildeDisc,
      }),
    });
    const [wrongNonceAccepted, wrongRecipientAccepted, tamperedEventAccepted] = await Promise.all([
      verifyVariant({ request: wrongNonce }),
      verifyVariant({ request: wrongRecipient }),
      verifyVariant({ event: tamperedEvent }),
    ]);
    if (wrongNonceAccepted || wrongRecipientAccepted || tamperedEventAccepted) {
      throw new Error("recipient-bound disclosure accepted a negative test");
    }
    const disclosed = decryptSettlementDisclosure({
      recipientSecret: recipient.secret,
      request,
      rDisc,
      vTildeDisc,
    });
    if (disclosed !== witness.amount) throw new Error("designated recipient decrypted the wrong amount");

    const bundle = {
      circuitId: "disclose_settlement",
      event: { contract: token, id: event.eventId, ledger: event.ledger, transaction: event.txHash },
      request,
      proof: Buffer.from(generated.proof).toString("hex"),
      rDisc,
      vTildeDisc,
    };
    writeFileSync(privatePath, `${JSON.stringify({
      recipientSecret: toHex32(recipient.secret),
      disclosedAmount: disclosed.toString(),
      bundle,
    }, null, 2)}\n`);
    writeFileSync(evidencePath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      network: "testnet",
      roundId: settlement.roundId,
      circuit: {
        id: bundle.circuitId,
        artifactSha256: hash(readFileSync(artifactPath)),
        verificationKeySha256: hash(verificationKey),
        verificationKeyBytes: verificationKey.length,
      },
      event: bundle.event,
      recipientBinding: {
        publicKeySha256: hash(`${request.recipientPublicKey.x}:${request.recipientPublicKey.y}`),
        nonceSha256: hash(request.nonce),
      },
      proof: { bytes: generated.proof.length, sha256: hash(generated.proof), verified: true },
      verification: {
        chainInputsReconstructed: true,
        designatedRecipientDecrypted: true,
        wrongNonceRejected: !wrongNonceAccepted,
        wrongRecipientRejected: !wrongRecipientAccepted,
        tamperedEventRejected: !tamperedEventAccepted,
      },
      privacyNote: "The disclosed amount, recipient secret, nonce, ciphertext and proof bundle remain only in the ignored private file.",
    }, null, 2)}\n`);
    console.log(`recipient-bound settlement disclosure verified: ${generated.proof.length} proof bytes`);
  } finally {
    await prover.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
