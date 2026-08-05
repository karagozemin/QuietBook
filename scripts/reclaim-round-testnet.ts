import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, Networks, rpc, scValToNative } from "@stellar/stellar-sdk";
import {
  ChainClient,
  addressToField,
  commit,
  deriveKeys,
  deriveSpendR,
  fromBytesBE,
  keypairSigner,
  pointFromBytes,
  proverFromArtifact,
} from "@ctd/sdk";
import {
  buildRevokeSpenderWitness,
  encodeRevokeSpenderData,
} from "../packages/sdk/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(
  readFileSync(join(root, "docs/evidence/testnet/deployment.json"), "utf8"),
);
const controller = JSON.parse(
  readFileSync(join(root, "docs/evidence/testnet/controller-smoke.json"), "utf8"),
);
const settlement = JSON.parse(
  readFileSync(join(root, "docs/evidence/testnet/settlement.json"), "utf8"),
);
const setup = JSON.parse(
  readFileSync(join(root, ".quietbook/round-setup-private.json"), "utf8"),
);
const privatePath = join(root, ".quietbook/reclaim-private.json");
const evidencePath = join(root, "docs/evidence/testnet/reclaim.json");
const DEPOSIT = 200_000_000n;

type ReclaimState = {
  transactions: Record<string, string>;
  proofHashes: Record<string, string>;
  spendables: Record<string, { value: string; randomness: string }>;
};

function stellar(args: string[]): string {
  return execFileSync("stellar", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function auditorPoint() {
  const x = Buffer.from(deployment.auditor.publicKey.x.replace(/^0x/, ""), "hex");
  const y = Buffer.from(deployment.auditor.publicKey.y.replace(/^0x/, ""), "hex");
  return pointFromBytes(new Uint8Array(Buffer.concat([x, y])));
}

function loadState(): ReclaimState {
  try {
    return JSON.parse(readFileSync(privatePath, "utf8"));
  } catch {
    return { transactions: {}, proofHashes: {}, spendables: {} };
  }
}

function saveState(state: ReclaimState) {
  writeFileSync(privatePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function setSpenderSalt(
  server: rpc.Server,
  token: string,
  transactionHash: string,
  eventName = "set_spender",
): Promise<bigint> {
  const response = await server.getEvents({
    startLedger: deployment.ledgerRange.start,
    filters: [{ type: "contract", contractIds: [token] }],
    limit: 100,
  });
  const event = response.events.find(
    (candidate) =>
      candidate.txHash === transactionHash && candidate.topic[0]?.sym().toString() === eventName,
  );
  const sigma = event?.value
    .map()
    ?.find((entry) => entry.key().sym().toString() === "sigma")
    ?.val();
  if (!sigma) throw new Error(`${eventName} event not found for ${transactionHash}`);
  return fromBytesBE(new Uint8Array(sigma.bytes()));
}

async function spendableCommitment(client: ChainClient, token: string, account: string) {
  const value = await client.simulate(token, "confidential_balance", [
    new Address(account).toScVal(),
  ]);
  const commitment = value
    .map()
    ?.find((entry) => entry.key().sym().toString() === "spendable_commitment")
    ?.val();
  if (!commitment) throw new Error(`spendable commitment not found for ${account}`);
  return pointFromBytes(new Uint8Array(commitment.bytes()));
}

async function main() {
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
  const state = loadState();
  state.spendables ??= {};
  const prover = proverFromArtifact(
    JSON.parse(readFileSync(join(root, "packages/sdk/circuits/revoke_spender.json"), "utf8")),
  );
  const kAud = auditorPoint();

  try {
    for (const bidder of setup.bidders as Array<{
      account: string;
      identity: string;
      sk: string;
      transactions: { setSpender: string };
      delegation: { value: string; randomness: string; sigmaA: string };
      spendable?: { value: string; randomness: string };
    }>) {
      if (bidder.account === settlement.winner) continue;

      const keys = deriveKeys(BigInt(bidder.sk), addrF);
      if (state.transactions[bidder.account] && !state.spendables[bidder.account]) {
        const sigma = await setSpenderSalt(
          client.server,
          token,
          state.transactions[bidder.account],
          "revoke_spender",
        );
        state.spendables[bidder.account] = {
          value: DEPOSIT.toString(),
          randomness: `0x${deriveSpendR(keys.vk, sigma).toString(16).padStart(64, "0")}`,
        };
        saveState(state);
      }
      if (state.transactions[bidder.account]) continue;
      const spendableValue = bidder.spendable
        ? BigInt(bidder.spendable.value)
        : DEPOSIT - BigInt(bidder.delegation.value);
      const spendableRandomness = bidder.spendable
        ? BigInt(bidder.spendable.randomness)
        : deriveSpendR(
            keys.vk,
            await setSpenderSalt(client.server, token, bidder.transactions.setSpender),
          );
      const witness = buildRevokeSpenderWitness({
        ownerKeys: keys,
        spendableValue,
        spendableRandomness,
        allowance: BigInt(bidder.delegation.value),
        allowanceRandomness: BigInt(bidder.delegation.randomness),
        allowanceSalt: BigInt(bidder.delegation.sigmaA),
        spenderId: addressToField(controller.controller),
        ownerAuditorKey: kAud,
      });
      const before = await spendableCommitment(client, token, bidder.account);
      if (!before.equals(commit(spendableValue, spendableRandomness))) {
        throw new Error(`${bidder.account} spendable opening does not match on-chain state`);
      }
      const generated = await prover.prove(witness.inputs);
      const signer = keypairSigner(
        stellar(["keys", "show", bidder.identity]),
        Networks.TESTNET,
      );
      const result = await client.invoke(
        token,
        "revoke_spender",
        [
          new Address(bidder.account).toScVal(),
          new Address(controller.controller).toScVal(),
          encodeRevokeSpenderData(witness, generated.proof),
        ],
        signer,
      );
      state.transactions[bidder.account] = result.hash;
      state.proofHashes[bidder.account] = createHash("sha256")
        .update(generated.proof)
        .digest("hex");
      state.spendables[bidder.account] = {
        value: witness.nextSpendable.value.toString(),
        randomness: `0x${witness.nextSpendable.randomness.toString(16).padStart(64, "0")}`,
      };
      const after = await spendableCommitment(client, token, bidder.account);
      if (!after.equals(witness.nextSpendable.commitment)) {
        throw new Error(`${bidder.account} reclaimed commitment does not match on-chain state`);
      }
      saveState(state);
    }

    const results = [];
    for (const [account, transaction] of Object.entries(state.transactions)) {
      const active = scValToNative(
        await client.simulate(token, "is_spender", [
          new Address(account).toScVal(),
          new Address(controller.controller).toScVal(),
        ]),
      );
      results.push({
        account,
        transaction,
        proofSha256: state.proofHashes[account],
        delegationRemoved: active === false,
      });
    }
    if (results.length !== 2 || results.some((result) => !result.delegationRemoved)) {
      throw new Error("expected two losing delegations to be reclaimed");
    }
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          roundId: settlement.roundId,
          controller: controller.controller,
          losingBidderReclaims: results,
          privacyNote: "No bid value, balance opening, confidential key, or witness is included.",
        },
        null,
        2,
      )}\n`,
    );
    console.log("two losing bidder delegations reclaimed");
  } finally {
    await prover.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
