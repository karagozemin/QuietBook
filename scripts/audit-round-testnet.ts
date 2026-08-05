import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Keypair, Networks, rpc, xdr } from "@stellar/stellar-sdk";
import { ChainClient, H, pointToBytes, scalarMul } from "@ctd/sdk";
import {
  decryptAllowanceEvent,
  decryptSpenderTransferEvent,
  parseAuditEvent,
  type AllowanceAuditEvent,
  type SpenderTransferAuditEvent,
} from "../packages/sdk/src/audit.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(join(root, "docs/evidence/testnet/deployment.json"), "utf8"));
const setup = JSON.parse(readFileSync(join(root, ".quietbook/round-setup-private.json"), "utf8"));
const auditorPrivate = JSON.parse(readFileSync(join(root, ".quietbook/testnet-private.json"), "utf8"));
const settlement = JSON.parse(readFileSync(join(root, "docs/evidence/testnet/settlement.json"), "utf8"));
const controller = JSON.parse(readFileSync(join(root, "docs/evidence/testnet/controller-smoke.json"), "utf8"));
const databasePath = join(root, ".quietbook/indexer.sqlite");
const privateExportPath = join(root, ".quietbook/audit-export.json");
const evidencePath = join(root, "docs/evidence/testnet/audit.json");

type EventRow = {
  id: string;
  contract_id: string;
  ledger: number;
  tx_hash: string;
  event_type: string;
  raw_xdr: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function rawRpcEvent(event: rpc.Api.EventResponse) {
  return JSON.stringify({
    topic: event.topic.map((item) => item.toXDR("base64")),
    value: event.value.toXDR("base64"),
  });
}

async function main() {
  const token = deployment.contracts.confidentialToken.contractId as string;
  const auditorContract = deployment.contracts.confidentialAuditor.contractId as string;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const bidTransactions = setup.bidders.map((bidder: { transactions: { setSpender: string } }) => bidder.transactions.setSpender);
  const placeholders = bidTransactions.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, contract_id, ledger, tx_hash, event_type, raw_xdr
    FROM chain_events
    WHERE contract_id = ? AND (tx_hash IN (${placeholders}) OR tx_hash = ?)
    ORDER BY ledger, id
  `).all(token, ...bidTransactions, settlement.finalizeTransaction) as unknown as EventRow[];
  const keyEvents = db.prepare(`
    SELECT event_type FROM chain_events
    WHERE contract_id = ? AND event_type IN ('auditor_registered', 'auditor_rotated')
    ORDER BY ledger, id
  `).all(auditorContract) as Array<{ event_type: string }>;
  db.close();

  const setRows = rows.filter((row) => row.event_type === "set_spender");
  const settlementRow = rows.find((row) => row.event_type === "spender_transfer");
  if (setRows.length !== setup.bidders.length || !settlementRow) {
    throw new Error("indexed auditor event set is incomplete; run pnpm sync:indexer first");
  }

  const server = new rpc.Server(deployment.rpcUrl);
  const rpcPage = await server.getEvents({
    startLedger: Math.min(...rows.map((row) => row.ledger)),
    filters: [{ type: "contract", contractIds: [token] }],
    limit: 100,
  });
  const rpcMatches = rows.map((row) => {
    const event = rpcPage.events.find((candidate) => candidate.id === row.id && candidate.txHash === row.tx_hash);
    return Boolean(event && rawRpcEvent(event) === row.raw_xdr);
  });
  if (!rpcMatches.every(Boolean)) throw new Error("indexer event XDR does not match direct RPC");

  const secret = BigInt(auditorPrivate.auditorSecretHex);
  const expectedPublicKey = new Uint8Array([
    ...Buffer.from(deployment.auditor.publicKey.x.replace(/^0x/, ""), "hex"),
    ...Buffer.from(deployment.auditor.publicKey.y.replace(/^0x/, ""), "hex"),
  ]);
  const derivedPublicKey = pointToBytes(scalarMul(secret, H));
  if (!Buffer.from(derivedPublicKey).equals(Buffer.from(expectedPublicKey))) {
    throw new Error("auditor secret does not match pinned public key");
  }

  const chain = new ChainClient({
    rpcUrl: deployment.rpcUrl,
    networkPassphrase: Networks.TESTNET,
    contracts: {
      token,
      verifier: deployment.contracts.confidentialVerifier.contractId,
      auditor: auditorContract,
    },
  });
  const onChainKey = await chain.simulate(auditorContract, "get_key", [xdr.ScVal.scvU32(deployment.auditor.id)]);
  if (!Buffer.from(onChainKey.bytes()).equals(Buffer.from(derivedPublicKey))) {
    throw new Error("auditor key does not match registry state");
  }
  const rotationCount = keyEvents.filter((event) => event.event_type === "auditor_rotated").length;
  if (keyEvents.filter((event) => event.event_type === "auditor_registered").length !== 1 || rotationCount !== 0) {
    throw new Error("unexpected auditor key history");
  }

  const bidRecords = setRows.map((row) => {
    const event = parseAuditEvent(row.raw_xdr, {
      ledger: row.ledger,
      txHash: row.tx_hash,
      eventId: row.id,
    }) as AllowanceAuditEvent;
    const decrypted = decryptAllowanceEvent(secret, event);
    const privateBidder = setup.bidders.find((bidder: { account: string }) => bidder.account === event.account);
    if (!privateBidder || decrypted.allowance !== BigInt(privateBidder.delegation.value)) {
      throw new Error(`auditor bid opening mismatch for ${event.account}`);
    }
    return {
      event: { id: event.eventId, ledger: event.ledger, transaction: event.txHash },
      account: event.account,
      spender: event.spender,
      keyVersion: 0,
      decrypted: {
        allowance: decrypted.allowance.toString(),
        ownerPostBalance: decrypted.ownerPostBalance.toString(),
      },
    };
  });

  const transferEvent = parseAuditEvent(settlementRow.raw_xdr, {
    ledger: settlementRow.ledger,
    txHash: settlementRow.tx_hash,
    eventId: settlementRow.id,
  }) as SpenderTransferAuditEvent;
  const transfer = decryptSpenderTransferEvent(secret, transferEvent);
  const winningBid = bidRecords.find((record) => record.account === settlement.winner);
  const linkageVerified =
    transferEvent.txHash === settlement.finalizeTransaction &&
    transferEvent.spender === controller.controller &&
    transferEvent.from === settlement.winner &&
    transferEvent.to === deployment.roles.issuer;
  if (!linkageVerified || !winningBid || transfer.amount.toString() !== winningBid.decrypted.allowance || !transfer.channelsAgree) {
    throw new Error("settlement auditor linkage or channel agreement failed");
  }

  const exportPayload = {
    format: "quietbook-audit-v1",
    safety: "STELLAR TESTNET / UNAUDITED PROTOTYPE",
    generatedAt: new Date().toISOString(),
    network: "testnet",
    roundId: settlement.roundId,
    tokenContract: token,
    auditor: {
      id: deployment.auditor.id,
      keyVersion: 0,
      registryContract: auditorContract,
      registrationTransaction: deployment.auditor.registrationTransactionHash,
      rotationCount,
    },
    bids: bidRecords,
    settlement: {
      event: { id: transferEvent.eventId, ledger: transferEvent.ledger, transaction: transferEvent.txHash },
      spender: transferEvent.spender,
      from: transferEvent.from,
      to: transferEvent.to,
      decrypted: {
        amount: transfer.amount.toString(),
        remainingAllowance: transfer.remainingAllowance.toString(),
        transferRandomness: transfer.transferRandomness.toString(),
      },
      channelsAgree: transfer.channelsAgree,
      linkageVerified,
    },
  };
  const payloadHash = Buffer.from(sha256(canonical(exportPayload)), "hex");
  const auditorSecret = execFileSync("stellar", ["keys", "show", "quietbook-auditor"], { encoding: "utf8" }).trim();
  const signer = Keypair.fromSecret(auditorSecret);
  if (signer.publicKey() !== deployment.roles.auditor) throw new Error("audit signer account mismatch");
  const signature = signer.sign(payloadHash);
  if (!Keypair.fromPublicKey(signer.publicKey()).verify(payloadHash, signature)) throw new Error("audit signature self-check failed");
  const privateExport = {
    ...exportPayload,
    integrity: {
      canonicalPayloadSha256: payloadHash.toString("hex"),
      signer: signer.publicKey(),
      signature: signature.toString("base64"),
    },
  };
  const privateJson = `${JSON.stringify(privateExport, null, 2)}\n`;
  writeFileSync(privateExportPath, privateJson);

  const evidence = {
    generatedAt: exportPayload.generatedAt,
    network: "testnet",
    roundId: settlement.roundId,
    auditor: {
      id: deployment.auditor.id,
      keyVersion: 0,
      publicKeyMatchesRegistry: true,
      registrationTransaction: deployment.auditor.registrationTransactionHash,
      rotationCount,
    },
    eventVerification: {
      indexedEvents: rows.length,
      directRpcXdrMatches: rpcMatches.every(Boolean),
      bidDelegationsDecrypted: bidRecords.length,
      settlementChannelsAgree: transfer.channelsAgree,
      settlementLinkageVerified: linkageVerified,
      references: rows.map((row) => ({ type: row.event_type, ledger: row.ledger, transaction: row.tx_hash, eventId: row.id })),
    },
    exportIntegrity: {
      privateExportSha256: sha256(privateJson),
      canonicalPayloadSha256: payloadHash.toString("hex"),
      signer: signer.publicKey(),
      signature: signature.toString("base64"),
      signatureVerified: true,
    },
    privacyNote: "Decrypted bid, payment, balance, randomness and auditor secret values remain only in the ignored private export.",
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`auditor evidence written: ${rows.length} events, values redacted`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
