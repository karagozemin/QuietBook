import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, nativeToScVal, Networks, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  ChainClient,
  addressToField,
  deriveKeys,
  encodeRegisterData,
  keypairSigner,
  pointFromBytes,
  proverFromArtifact,
  randomScalar,
  toHex32,
} from "@ctd/sdk";
import {
  buildAccountBoundRegisterWitness,
  buildRevokeSpenderWitness,
  buildSetSpenderWitness,
  encodeRevokeSpenderData,
  encodeSetSpenderData,
} from "../packages/sdk/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(
  root,
  "contracts/target/wasm32v1-none/release/quietbook_market.wasm",
);
const controllerWasmPath = join(
  root,
  "contracts/target/wasm32v1-none/release/quietbook_round_controller.wasm",
);
const deployment = JSON.parse(
  readFileSync(join(root, "docs/evidence/testnet/deployment.json"), "utf8"),
);
const setup = JSON.parse(
  readFileSync(join(root, ".quietbook/round-setup-private.json"), "utf8"),
);
const reclaim = JSON.parse(
  readFileSync(join(root, ".quietbook/reclaim-private.json"), "utf8"),
);
const privatePath = join(root, ".quietbook/withdrawal-smoke-private.json");
const evidencePath = join(root, "docs/evidence/testnet/withdrawal.json");

type State = {
  market?: string;
  controller?: string;
  controllerSk?: string;
  roundId?: string;
  bidDeadline?: number;
  settlementDeadline?: number;
  allowance?: string;
  deploymentTransactions?: string[];
  transactions: Record<string, string>;
  proofs: Record<string, string>;
  delegation?: {
    value: string;
    randomness: string;
    sigmaA: string;
    spendableValue: string;
    spendableRandomness: string;
  };
};

function loadState(): State {
  try {
    return JSON.parse(readFileSync(privatePath, "utf8"));
  } catch {
    return { transactions: {}, proofs: {} };
  }
}

function saveState(state: State) {
  writeFileSync(privatePath, `${JSON.stringify(state, null, 2)}\n`);
}

function stellar(args: string[]) {
  const result = spawnSync("stellar", args, { encoding: "utf8" });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(combined);
  return {
    stdout: result.stdout.trim(),
    hashes: [...combined.matchAll(/\/tx\/([0-9a-f]{64})/g)].map((match) => match[1]!),
  };
}

function secret(identity: string): string {
  return execFileSync("stellar", ["keys", "show", identity], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key]! })),
  );
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
  const state = loadState();
  state.transactions ??= {};
  state.proofs ??= {};
  const token = deployment.contracts.confidentialToken.contractId as string;
  const issuer = deployment.roles.issuer as string;
  const client = new ChainClient({
    rpcUrl: deployment.rpcUrl,
    networkPassphrase: Networks.TESTNET,
    contracts: {
      token,
      verifier: deployment.contracts.confidentialVerifier.contractId,
      auditor: deployment.contracts.confidentialAuditor.contractId,
    },
  });

  if (!state.market) {
    const result = stellar([
      "contract",
      "deploy",
      "--wasm",
      wasmPath,
      "--source",
      "quietbook-deployer",
      "--network",
      "testnet",
      "--optimize=false",
    ]);
    state.market = result.stdout.split(/\s+/).findLast((value) => value.startsWith("C"));
    state.deploymentTransactions = result.hashes;
    if (!state.market) throw new Error("market contract id missing from deploy output");
    saveState(state);
  }

  if (!state.controller) {
    const latest = await client.latestLedger();
    state.bidDeadline = latest + 120;
    state.settlementDeadline = latest + 300;
    state.controllerSk = toHex32(randomScalar());
    const result = stellar([
      "contract",
      "deploy",
      "--wasm",
      controllerWasmPath,
      "--source",
      "quietbook-deployer",
      "--network",
      "testnet",
      "--optimize=false",
      "--",
      "--market",
      state.market,
      "--confidential_token",
      token,
      "--issuer_recipient",
      issuer,
      "--settlement_deadline_ledger",
      String(state.settlementDeadline),
    ]);
    state.controller = result.stdout.split(/\s+/).findLast((value) => value.startsWith("C"));
    state.deploymentTransactions = [...(state.deploymentTransactions ?? []), ...result.hashes];
    if (!state.controller) throw new Error("controller contract id missing from deploy output");
    saveState(state);
  }

  const market = state.market;
  const controller = state.controller;
  const issuerSigner = keypairSigner(secret("quietbook-issuer"), Networks.TESTNET);
  const addrF = addressToField(token);
  const registerProver = proverFromArtifact(
    JSON.parse(readFileSync(join(root, "packages/sdk/circuits/register.json"), "utf8")),
  );
  const setSpenderProver = proverFromArtifact(
    JSON.parse(readFileSync(join(root, "packages/sdk/circuits/set_spender.json"), "utf8")),
  );
  const revokeProver = proverFromArtifact(
    JSON.parse(readFileSync(join(root, "packages/sdk/circuits/revoke_spender.json"), "utf8")),
  );

  try {
    if (!state.roundId) {
      const config = struct({
        auditor_id: xdr.ScVal.scvU32(0),
        bid_deadline_ledger: xdr.ScVal.scvU32(state.bidDeadline!),
        confidential_token: new Address(token).toScVal(),
        controller: new Address(controller).toScVal(),
        eligibility_policy: new Address(
          deployment.contracts.eligibilityPolicy.contractId,
        ).toScVal(),
        issuer: new Address(issuer).toScVal(),
        max_bid_verifier: new Address(
          deployment.contracts.maxBidVerifier.contractId,
        ).toScVal(),
        reserve_public: nativeToScVal(80_000_000n, { type: "i128" }),
        rwa_lot: nativeToScVal(10_000_000n, { type: "i128" }),
        rwa_token: new Address(deployment.contracts.rwaToken.contractId).toScVal(),
        settlement_deadline_ledger: xdr.ScVal.scvU32(state.settlementDeadline!),
      });
      const result = await client.invoke(market, "create_round", [config], issuerSigner);
      if (!result.returnValue) throw new Error("create_round returned no round id");
      state.roundId = Buffer.from(result.returnValue.bytes()).toString("hex");
      state.transactions.createRound = result.hash;
      saveState(state);
    }

    if (!state.transactions.registerController) {
      const controllerKeys = deriveKeys(BigInt(state.controllerSk!), addrF);
      const witness = buildAccountBoundRegisterWitness(controllerKeys, controller);
      const generated = await registerProver.prove(witness.inputs);
      const result = await client.invoke(
        market,
        "register_controller",
        [bytes32(state.roundId), xdr.ScVal.scvU32(0), encodeRegisterData(witness, generated.proof)],
        issuerSigner,
      );
      state.transactions.registerController = result.hash;
      state.proofs.registerController = createHash("sha256").update(generated.proof).digest("hex");
      saveState(state);
    }

    if (!state.transactions.mintRwa) {
      const result = await client.invoke(
        deployment.contracts.rwaToken.contractId,
        "mint",
        [new Address(issuer).toScVal(), nativeToScVal(10_000_000n, { type: "i128" })],
        issuerSigner,
      );
      state.transactions.mintRwa = result.hash;
      saveState(state);
    }
    if (!state.transactions.fundRound) {
      const result = await client.invoke(market, "fund_round", [bytes32(state.roundId)], issuerSigner);
      state.transactions.fundRound = result.hash;
      saveState(state);
    }
    if (!state.transactions.openRound) {
      const result = await client.invoke(market, "open_round", [bytes32(state.roundId)], issuerSigner);
      state.transactions.openRound = result.hash;
      saveState(state);
    }

    const bidder = setup.bidders.find(
      (candidate: { account: string }) => reclaim.spendables[candidate.account],
    );
    if (!bidder) throw new Error("no reclaimed bidder checkpoint available");
    const bidderSigner = keypairSigner(secret(bidder.identity), Networks.TESTNET);
    const ownerKeys = deriveKeys(BigInt(bidder.sk), addrF);
    const priorSpendable = reclaim.spendables[bidder.account];
    const controllerKeys = deriveKeys(BigInt(state.controllerSk!), addrF);

    if (!state.transactions.setSpender) {
      state.allowance ??= (90_000_000n + (randomScalar() % 30_000_000n)).toString();
      const witness = buildSetSpenderWitness({
        ownerKeys,
        spendableValue: BigInt(priorSpendable.value),
        spendableRandomness: BigInt(priorSpendable.randomness),
        allowance: BigInt(state.allowance),
        spenderKeys: controllerKeys,
        spenderId: addressToField(controller),
        ownerAuditorKey: auditorPoint(),
      });
      const generated = await setSpenderProver.prove(witness.inputs);
      const result = await client.invoke(
        token,
        "set_spender",
        [
          new Address(bidder.account).toScVal(),
          new Address(controller).toScVal(),
          xdr.ScVal.scvU32(state.settlementDeadline!),
          encodeSetSpenderData(witness, generated.proof),
        ],
        bidderSigner,
      );
      state.transactions.setSpender = result.hash;
      state.proofs.setSpender = createHash("sha256").update(generated.proof).digest("hex");
      state.delegation = {
        value: witness.delegation.value.toString(),
        randomness: toHex32(witness.delegation.randomness),
        sigmaA: toHex32(witness.delegation.sigmaA),
        spendableValue: witness.nextSpendable.value.toString(),
        spendableRandomness: toHex32(witness.nextSpendable.randomness),
      };
      saveState(state);
    }

    if (!state.transactions.registerBid) {
      const result = await client.invoke(
        market,
        "register_bid",
        [bytes32(state.roundId), new Address(bidder.account).toScVal()],
        bidderSigner,
      );
      state.transactions.registerBid = result.hash;
      saveState(state);
    }

    if (!state.transactions.withdrawBid) {
      const delegation = state.delegation!;
      const witness = buildRevokeSpenderWitness({
        ownerKeys,
        spendableValue: BigInt(delegation.spendableValue),
        spendableRandomness: BigInt(delegation.spendableRandomness),
        allowance: BigInt(delegation.value),
        allowanceRandomness: BigInt(delegation.randomness),
        allowanceSalt: BigInt(delegation.sigmaA),
        spenderId: addressToField(controller),
        ownerAuditorKey: auditorPoint(),
      });
      const generated = await revokeProver.prove(witness.inputs);
      const result = await client.invoke(
        market,
        "withdraw_bid",
        [
          bytes32(state.roundId),
          new Address(bidder.account).toScVal(),
          encodeRevokeSpenderData(witness, generated.proof),
        ],
        bidderSigner,
      );
      state.transactions.withdrawBid = result.hash;
      state.proofs.withdrawBid = createHash("sha256").update(generated.proof).digest("hex");
      saveState(state);
    }

    const round = scValToNative(
      await client.simulate(market, "get_round", [bytes32(state.roundId)]),
    );
    const bid = scValToNative(
      await client.simulate(market, "get_bid", [
        bytes32(state.roundId),
        new Address(bidder.account).toScVal(),
      ]),
    );
    const delegated = scValToNative(
      await client.simulate(token, "is_spender", [
        new Address(bidder.account).toScVal(),
        new Address(controller).toScVal(),
      ]),
    );
    if (round.bidder_count !== 0 || bid.active !== false || delegated !== false) {
      throw new Error("withdrawal readback mismatch");
    }

    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          network: "testnet",
          market,
          controller,
          roundId: state.roundId,
          bidder: bidder.account,
          marketWasmSha256: createHash("sha256").update(readFileSync(wasmPath)).digest("hex"),
          deploymentTransactions: state.deploymentTransactions,
          transactions: state.transactions,
          proofSha256: state.proofs,
          readBack: {
            roundStatus: Array.isArray(round.status) ? round.status[0] : round.status,
            bidderCount: round.bidder_count,
            bidActive: bid.active,
            delegationRemoved: delegated === false,
          },
          privacyNote: "No bid value, balance opening, confidential key, or witness is included.",
        },
        null,
        2,
      )}\n`,
    );
    console.log(`withdrawal verified on Testnet: ${state.transactions.withdrawBid}`);
  } finally {
    await Promise.all([registerProver.destroy(), setSpenderProver.destroy(), revokeProver.destroy()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
