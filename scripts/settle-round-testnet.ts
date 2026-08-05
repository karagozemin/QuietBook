import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Address, Networks, xdr } from "@stellar/stellar-sdk";
import {
  ChainClient,
  H,
  addressToField,
  deriveKeys,
  fromBytesBE,
  keypairSigner,
  pointFromBytes,
  pointToBytes,
  proverFromArtifact,
} from "@ctd/sdk";
import {
  buildMaxBidWitness,
  buildSpenderTransferWitness,
  encodeSpenderTransferData,
} from "../packages/sdk/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(join(root, "docs/evidence/testnet/deployment.json"), "utf8"));
const controllerState = JSON.parse(readFileSync(join(root, ".quietbook/controller-smoke-private.json"), "utf8"));
const setupState = JSON.parse(readFileSync(join(root, ".quietbook/round-setup-private.json"), "utf8"));
const issuerState = JSON.parse(readFileSync(join(root, ".quietbook/testnet-smoke-private.json"), "utf8"));
const privatePath = join(root, ".quietbook/settlement-private.json");
const evidencePath = join(root, "docs/evidence/testnet/settlement.json");
const WINNER_INDEX = 1;

function stellar(args: string[]): string {
  return execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function roundIdVal(): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(controllerState.roundId, "hex"));
}

function auditorPoint() {
  const x = Buffer.from(deployment.auditor.publicKey.x.replace(/^0x/, ""), "hex");
  const y = Buffer.from(deployment.auditor.publicKey.y.replace(/^0x/, ""), "hex");
  return pointFromBytes(new Uint8Array(Buffer.concat([x, y])));
}

function proofPublicInputs(values: string[]): Buffer {
  return Buffer.concat(
    values.map((value) => Buffer.from(value.replace(/^0x/, "").padStart(64, "0"), "hex")),
  );
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const market = deployment.contracts.market.contractId as string;
  const token = deployment.contracts.confidentialToken.contractId as string;
  const addrF = addressToField(token);
  const client = new ChainClient({
    rpcUrl: deployment.rpcUrl,
    networkPassphrase: Networks.TESTNET,
    contracts: {
      token,
      verifier: deployment.contracts.confidentialVerifier.contractId,
      auditor: deployment.contracts.confidentialAuditor.contractId,
    },
  });
  const operatorSigner = keypairSigner(
    stellar(["keys", "show", "quietbook-operator"]),
    Networks.TESTNET,
  );
  let settlementState: { closeTransaction?: string } = {};
  try {
    settlementState = JSON.parse(readFileSync(privatePath, "utf8"));
  } catch {}

  if (!settlementState.closeTransaction) {
    let ledger = await client.latestLedger();
    while (ledger <= controllerState.bidDeadline) {
      console.log(`waiting for close: ledger ${ledger}/${controllerState.bidDeadline + 1}`);
      await sleep(5_000);
      ledger = await client.latestLedger();
    }
    const closed = await client.invoke(market, "close_round", [roundIdVal()], operatorSigner);
    settlementState.closeTransaction = closed.hash;
    writeFileSync(privatePath, `${JSON.stringify(settlementState, null, 2)}\n`);
  }

  const controllerKeys = deriveKeys(BigInt(controllerState.controllerSk), addrF);
  const issuerKeys = deriveKeys(BigInt(issuerState.issuerConfidentialSk), addrF);
  const winner = setupState.bidders[WINNER_INDEX];
  const delegation = winner.delegation;
  if (!delegation) throw new Error("winner delegation opening missing from private state");
  const kAud = auditorPoint();
  const transferWitness = buildSpenderTransferWitness({
    spenderKeys: controllerKeys,
    delegationDvk: BigInt(delegation.dvk),
    allowance: BigInt(delegation.value),
    allowanceRandomness: BigInt(delegation.randomness),
    allowanceSalt: BigInt(delegation.sigmaA),
    amount: BigInt(delegation.value),
    recipientViewingKey: issuerKeys.PVK,
    recipientAuditorKey: kAud,
    ownerAuditorKey: kAud,
  });
  const transferProver = proverFromArtifact(
    JSON.parse(readFileSync(join(root, "packages/sdk/circuits/spender_transfer.json"), "utf8")),
  );
  const maxBidProver = proverFromArtifact(
    JSON.parse(readFileSync(join(root, "packages/sdk/circuits/max_bid.json"), "utf8")),
  );
  try {
    const transferProof = await transferProver.prove(transferWitness.inputs);
    const transferData = encodeSpenderTransferData(transferWitness, transferProof.proof);
    const statement = await client.simulate(market, "max_bid_public_inputs", [
      roundIdVal(),
      xdr.ScVal.scvU32(WINNER_INDEX),
      transferData,
    ]);
    const statementBytes = Buffer.from(statement.bytes());
    if (statementBytes.length !== 14 * 32) {
      throw new Error(`unexpected market statement length ${statementBytes.length}`);
    }
    const roundDomain = fromBytesBE(statementBytes.subarray(0, 32));
    const maxBidWitness = buildMaxBidWitness({
      roundDomain,
      bids: setupState.bidders.map((bidder: typeof winner) => ({
        value: BigInt(bidder.delegation.value),
        randomness: BigInt(bidder.delegation.randomness),
      })),
      reserve: 80_000_000n,
      payment: transferWitness.paymentOpening,
    });
    if (maxBidWitness.winnerIndex !== WINNER_INDEX) throw new Error("private winner mismatch");
    const maxBidProof = await maxBidProver.prove(maxBidWitness.inputs);
    const proverStatement = proofPublicInputs(maxBidProof.publicInputs);
    if (!proverStatement.equals(statementBytes)) {
      throw new Error("Max-Bid prover public inputs do not byte-match the market statement");
    }

    const finalized = await client.invoke(
      market,
      "finalize",
      [
        roundIdVal(),
        xdr.ScVal.scvU32(WINNER_INDEX),
        xdr.ScVal.scvBytes(Buffer.from(maxBidProof.proof)),
        transferData,
      ],
      operatorSigner,
    );
    const evidence = {
      generatedAt: new Date().toISOString(),
      roundId: controllerState.roundId,
      winner: winner.account,
      winnerRegistrationIndex: WINNER_INDEX,
      closeTransaction: settlementState.closeTransaction,
      finalizeTransaction: finalized.hash,
      explorer: `https://stellar.expert/explorer/testnet/tx/${finalized.hash}`,
      maxBidProof: {
        bytes: maxBidProof.proof.length,
        sha256: createHash("sha256").update(maxBidProof.proof).digest("hex"),
        publicInputBytes: statementBytes.length,
        marketStatementMatched: true,
      },
      spenderTransferProof: {
        bytes: transferProof.proof.length,
        sha256: createHash("sha256").update(transferProof.proof).digest("hex"),
      },
      privacyNote: "No bid value, allowance opening, or confidential key is included.",
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    writeFileSync(
      privatePath,
      `${JSON.stringify({ ...settlementState, finalizeTransaction: finalized.hash, paymentCommitment: Buffer.from(pointToBytes(transferWitness.paymentOpening.commitment)).toString("hex") }, null, 2)}\n`,
    );
    console.log(`round settled atomically: ${finalized.hash}`);
  } finally {
    await Promise.all([transferProver.destroy(), maxBidProver.destroy()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
