import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Address, nativeToScVal, Networks, xdr } from "@stellar/stellar-sdk";
import {
  ChainClient,
  addressToField,
  deriveKeys,
  keypairSigner,
  pointFromBytes,
  proverFromArtifact,
  randomScalar,
  submitDeposit,
  submitMerge,
  submitRegister,
  toHex32,
} from "@ctd/sdk";
import {
  buildAccountBoundRegisterWitness,
  buildSetSpenderWitness,
  encodeSetSpenderData,
} from "../packages/sdk/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(join(root, "docs/evidence/testnet/deployment.json"), "utf8"));
const controllerState = JSON.parse(readFileSync(join(root, ".quietbook/controller-smoke-private.json"), "utf8"));
const privatePath = join(root, ".quietbook/round-setup-private.json");
const evidencePath = join(root, "docs/evidence/testnet/round-setup.json");
const DEPOSIT = 200_000_000n;
const PRIVATE_BIDS = [100_000_000n, 120_000_000n, 110_000_000n];

type BidderState = {
  account: string;
  identity: string;
  sk: string;
  transactions: Record<string, string>;
  delegation?: { value: string; randomness: string; dvk: string; sigmaA: string };
};

type State = {
  bidders: BidderState[];
  transactions: Record<string, string>;
  rejectedError?: string;
};

function stellar(args: string[]): string {
  return execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function save(state: State) {
  writeFileSync(privatePath, `${JSON.stringify(state, null, 2)}\n`);
}

function bytes32(hex: string): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
}

function auditorPoint() {
  const x = Buffer.from(deployment.auditor.publicKey.x.replace(/^0x/, ""), "hex");
  const y = Buffer.from(deployment.auditor.publicKey.y.replace(/^0x/, ""), "hex");
  return pointFromBytes(new Uint8Array(Buffer.concat([x, y])));
}

async function main() {
  const token = deployment.contracts.confidentialToken.contractId as string;
  const market = deployment.contracts.market.contractId as string;
  const policy = deployment.contracts.eligibilityPolicy.contractId as string;
  const rwa = deployment.contracts.rwaToken.contractId as string;
  const issuer = deployment.roles.issuer as string;
  const controller = controllerState.controller as string;
  const roundId = controllerState.roundId as string;
  const settlementDeadline = controllerState.settlementDeadline as number;
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
  const latest = await client.latestLedger();
  if (latest >= controllerState.bidDeadline) throw new Error("bid deadline passed; create a new round");

  let state: State;
  try {
    state = JSON.parse(readFileSync(privatePath, "utf8"));
  } catch {
    state = {
      bidders: [1, 2, 3].map((number) => {
        const identity = `quietbook-bidder-${number}`;
        return {
          identity,
          account: stellar(["keys", "public-key", identity]),
          sk: toHex32(randomScalar()),
          transactions: {},
        };
      }),
      transactions: {},
    };
    save(state);
  }

  const registerProver = proverFromArtifact(
    JSON.parse(readFileSync(join(root, "packages/sdk/circuits/register.json"), "utf8")),
  );
  const setSpenderProver = proverFromArtifact(
    JSON.parse(readFileSync(join(root, "packages/sdk/circuits/set_spender.json"), "utf8")),
  );
  const controllerKeys = deriveKeys(BigInt(controllerState.controllerSk), addrF);
  const kAud = auditorPoint();

  try {
    for (let index = 0; index < state.bidders.length; index += 1) {
      const bidder = state.bidders[index]!;
      const signer = keypairSigner(stellar(["keys", "show", bidder.identity]), Networks.TESTNET);
      const keys = deriveKeys(BigInt(bidder.sk), addrF);

      if (!bidder.transactions.register) {
        const witness = buildAccountBoundRegisterWitness(keys, bidder.account);
        const generated = await registerProver.prove(witness.inputs);
        const result = await submitRegister(client, signer, bidder.account, 0, witness, generated.proof);
        bidder.transactions.register = result.hash;
        save(state);
      }
      if (!bidder.transactions.deposit) {
        const result = await submitDeposit(client, signer, bidder.account, bidder.account, DEPOSIT);
        bidder.transactions.deposit = result.hash;
        save(state);
      }
      if (!bidder.transactions.merge) {
        const result = await submitMerge(client, signer, bidder.account);
        bidder.transactions.merge = result.hash;
        save(state);
      }
      if (!bidder.transactions.setSpender) {
        const witness = buildSetSpenderWitness({
          ownerKeys: keys,
          spendableValue: DEPOSIT,
          spendableRandomness: 0n,
          allowance: PRIVATE_BIDS[index]!,
          spenderKeys: controllerKeys,
          spenderId: addressToField(controller),
          ownerAuditorKey: kAud,
        });
        const generated = await setSpenderProver.prove(witness.inputs);
        const result = await client.invoke(
          token,
          "set_spender",
          [
            new Address(bidder.account).toScVal(),
            new Address(controller).toScVal(),
            xdr.ScVal.scvU32(settlementDeadline),
            encodeSetSpenderData(witness, generated.proof),
          ],
          signer,
        );
        bidder.transactions.setSpender = result.hash;
        bidder.delegation = {
          value: witness.delegation.value.toString(),
          randomness: toHex32(witness.delegation.randomness),
          dvk: toHex32(witness.delegation.dvk),
          sigmaA: toHex32(witness.delegation.sigmaA),
        };
        save(state);
      }
    }

    const issuerSigner = keypairSigner(stellar(["keys", "show", "quietbook-issuer"]), Networks.TESTNET);
    for (const bidder of state.bidders) {
      const key = `allow:${bidder.account}`;
      if (!state.transactions[key]) {
        const result = await client.invoke(
          policy,
          "set_authorized",
          [new Address(bidder.account).toScVal(), xdr.ScVal.scvBool(true)],
          issuerSigner,
        );
        state.transactions[key] = result.hash;
        save(state);
      }
    }
    if (!state.transactions.mintRwa) {
      const result = await client.invoke(
        rwa,
        "mint",
        [new Address(issuer).toScVal(), nativeToScVal(10_000_000n, { type: "i128" })],
        issuerSigner,
      );
      state.transactions.mintRwa = result.hash;
      save(state);
    }
    if (!state.transactions.fundRound) {
      const result = await client.invoke(market, "fund_round", [bytes32(roundId)], issuerSigner);
      state.transactions.fundRound = result.hash;
      save(state);
    }
    if (!state.transactions.openRound) {
      const result = await client.invoke(market, "open_round", [bytes32(roundId)], issuerSigner);
      state.transactions.openRound = result.hash;
      save(state);
    }
    for (const bidder of state.bidders) {
      if (!bidder.transactions.registerBid) {
        const signer = keypairSigner(stellar(["keys", "show", bidder.identity]), Networks.TESTNET);
        const result = await client.invoke(
          market,
          "register_bid",
          [bytes32(roundId), new Address(bidder.account).toScVal()],
          signer,
        );
        bidder.transactions.registerBid = result.hash;
        save(state);
      }
    }
    if (!state.rejectedError) {
      const rejected = deployment.roles.rejected as string;
      const signer = keypairSigner(stellar(["keys", "show", "quietbook-rejected"]), Networks.TESTNET);
      try {
        await client.invoke(
          market,
          "register_bid",
          [bytes32(roundId), new Address(rejected).toScVal()],
          signer,
        );
        throw new Error("unauthorized bidder unexpectedly registered");
      } catch (error) {
        state.rejectedError = String(error).slice(0, 500);
        save(state);
      }
    }

    const evidence = {
      generatedAt: new Date().toISOString(),
      roundId,
      controller,
      bidderAccounts: state.bidders.map((bidder) => bidder.account),
      bidderTransactions: state.bidders.map((bidder) => bidder.transactions),
      roundTransactions: state.transactions,
      rejectedAccount: deployment.roles.rejected,
      unauthorizedRegistrationRejected: Boolean(state.rejectedError),
      privacyNote: "Bid values, openings, and confidential keys are intentionally excluded.",
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log("round opened with three registered confidential bidders");
  } finally {
    await Promise.all([registerProver.destroy(), setSpenderProver.destroy()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
