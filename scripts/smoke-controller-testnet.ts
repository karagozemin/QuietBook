import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Address, nativeToScVal, Networks, xdr } from "@stellar/stellar-sdk";
import {
  ChainClient,
  addressToField,
  deriveKeys,
  encodeRegisterData,
  keypairSigner,
  proverFromArtifact,
  randomScalar,
  toHex32,
} from "@ctd/sdk";
import { buildAccountBoundRegisterWitness } from "../packages/sdk/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(
  readFileSync(join(root, "docs/evidence/testnet/deployment.json"), "utf8"),
);
const privatePath = join(root, ".quietbook/controller-smoke-private.json");
const evidencePath = join(root, "docs/evidence/testnet/controller-smoke.json");

function stellar(args: string[]) {
  const result = spawnSync("stellar", args, { encoding: "utf8" });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(combined);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    stdout: result.stdout.trim(),
    hashes: [...combined.matchAll(/\/tx\/([0-9a-f]{64})/g)].map((match) => match[1]!),
  };
}

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key]! })),
  );
}

async function main() {
  const market = deployment.contracts.market.contractId as string;
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
  const currentLedger = await client.latestLedger();
  const bidDeadline = currentLedger + 120;
  const settlementDeadline = currentLedger + 300;
  const controllerDeploy = stellar([
    "contract",
    "deploy",
    "--wasm",
    join(root, "contracts/target/wasm32v1-none/release/quietbook_round_controller.wasm"),
    "--source",
    "quietbook-deployer",
    "--network",
    "testnet",
    "--optimize=false",
    "--",
    "--market",
    market,
    "--confidential_token",
    token,
    "--issuer_recipient",
    issuer,
    "--settlement_deadline_ledger",
    String(settlementDeadline),
  ]);
  const controller = controllerDeploy.stdout.split(/\s+/).findLast((value) => value.startsWith("C"));
  if (!controller) throw new Error("controller id missing from deploy output");

  const issuerSecret = stellar(["keys", "show", "quietbook-issuer"]).stdout;
  const issuerSigner = keypairSigner(issuerSecret, Networks.TESTNET);
  const config = struct({
    auditor_id: xdr.ScVal.scvU32(0),
    bid_deadline_ledger: xdr.ScVal.scvU32(bidDeadline),
    confidential_token: new Address(token).toScVal(),
    controller: new Address(controller).toScVal(),
    eligibility_policy: new Address(deployment.contracts.eligibilityPolicy.contractId).toScVal(),
    issuer: new Address(issuer).toScVal(),
    max_bid_verifier: new Address(deployment.contracts.maxBidVerifier.contractId).toScVal(),
    reserve_public: nativeToScVal(80_000_000n, { type: "i128" }),
    rwa_lot: nativeToScVal(10_000_000n, { type: "i128" }),
    rwa_token: new Address(deployment.contracts.rwaToken.contractId).toScVal(),
    settlement_deadline_ledger: xdr.ScVal.scvU32(settlementDeadline),
  });
  const created = await client.invoke(market, "create_round", [config], issuerSigner);
  if (!created.returnValue) throw new Error("create_round returned no round id");
  const roundId = Buffer.from(created.returnValue.bytes()).toString("hex");

  const controllerKeys = deriveKeys(randomScalar(), addressToField(token));
  const witness = buildAccountBoundRegisterWitness(controllerKeys, controller);
  const artifactBytes = readFileSync(join(root, "packages/sdk/circuits/register.json"));
  const prover = proverFromArtifact(JSON.parse(artifactBytes.toString("utf8")));
  try {
    const generated = await prover.prove(witness.inputs);
    const registered = await client.invoke(
      market,
      "register_controller",
      [
        xdr.ScVal.scvBytes(Buffer.from(roundId, "hex")),
        xdr.ScVal.scvU32(0),
        encodeRegisterData(witness, generated.proof),
      ],
      issuerSigner,
    );
    mkdirSync(dirname(privatePath), { recursive: true });
    writeFileSync(
      privatePath,
      `${JSON.stringify({ controller, controllerSk: toHex32(controllerKeys.sk), roundId, bidDeadline, settlementDeadline }, null, 2)}\n`,
    );
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          market,
          controller,
          roundId,
          bidDeadline,
          settlementDeadline,
          controllerDeploymentTransactions: controllerDeploy.hashes,
          roundCreationTransaction: created.hash,
          controllerRegistrationTransaction: registered.hash,
          registerProofSha256: createHash("sha256").update(generated.proof).digest("hex"),
          registerCircuitArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`controller registered through market: ${registered.hash}`);
  } finally {
    await prover.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
