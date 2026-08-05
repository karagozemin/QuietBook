import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Address, Networks, xdr } from "@stellar/stellar-sdk";
import {
  ChainClient,
  H,
  keypairSigner,
  pointCoords,
  pointToBytes,
  randomScalar,
  scalarMul,
  toHex32,
} from "@ctd/sdk";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const network = "testnet";
const rpcUrl = "https://soroban-testnet.stellar.org";
const source = "quietbook-deployer";
const outPath = join(root, "docs/evidence/testnet/deployment.json");
const partialPath = join(root, ".quietbook/testnet-deployment-partial.json");
const privatePath = join(root, ".quietbook/testnet-private.json");
const wasmDir = join(root, "contracts/target/wasm32v1-none/release");
const circuitsDir = join(root, "packages/sdk/circuits");

const wasm = {
  confidentialVerifier: join(wasmDir, "quietbook_confidential_verifier.wasm"),
  confidentialAuditor: join(wasmDir, "quietbook_confidential_auditor.wasm"),
  confidentialToken: join(wasmDir, "quietbook_confidential_token.wasm"),
  maxBidVerifier: join(wasmDir, "quietbook_max_bid_verifier.wasm"),
  eligibilityPolicy: join(wasmDir, "quietbook_eligibility_policy.wasm"),
  rwaToken: join(wasmDir, "quietbook_demo_rwa_token.wasm"),
  market: join(wasmDir, "quietbook_market.wasm"),
} as const;

const roleNames = {
  deployer: "quietbook-deployer",
  issuer: "quietbook-issuer",
  operator: "quietbook-operator",
  auditor: "quietbook-auditor",
  bidder1: "quietbook-bidder-1",
  bidder2: "quietbook-bidder-2",
  bidder3: "quietbook-bidder-3",
  rejected: "quietbook-rejected",
} as const;

type CliResult = { stdout: string; transactionHashes: string[] };

function stellar(args: string[]): CliResult {
  const result = spawnSync("stellar", args, { encoding: "utf8" });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`stellar ${args.join(" ")} failed:\n${combined}`);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    stdout: result.stdout.trim(),
    transactionHashes: [...combined.matchAll(/\/tx\/([0-9a-f]{64})/g)].map((match) => match[1]!),
  };
}

function publicKey(identity: string): string {
  return stellar(["keys", "public-key", identity]).stdout;
}

function secret(identity: string): string {
  return stellar(["keys", "show", identity]).stdout;
}

function deploy(path: string, constructorArgs: string[] = []) {
  const args = [
    "contract",
    "deploy",
    "--wasm",
    path,
    "--source",
    source,
    "--network",
    network,
    "--optimize=false",
  ];
  if (constructorArgs.length > 0) args.push("--", ...constructorArgs);
  const result = stellar(args);
  const contractId = result.stdout.split(/\s+/).findLast((value) => value.startsWith("C"));
  if (!contractId) throw new Error(`could not parse contract id from: ${result.stdout}`);
  return { contractId, transactionHashes: result.transactionHashes };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main() {
  if (existsSync(outPath) && process.env.QUIETBOOK_REDEPLOY !== "1") {
    throw new Error(`${outPath} already exists; set QUIETBOOK_REDEPLOY=1 for an explicit redeploy`);
  }
  for (const path of Object.values(wasm)) {
    if (!existsSync(path)) throw new Error(`missing Wasm: ${path}`);
  }

  const roles = Object.fromEntries(
    Object.entries(roleNames).map(([role, identity]) => [role, publicKey(identity)]),
  ) as Record<keyof typeof roleNames, string>;
  const client = new ChainClient({
    rpcUrl,
    networkPassphrase: Networks.TESTNET,
    contracts: { token: roles.deployer, verifier: roles.deployer, auditor: roles.deployer },
  });
  const startLedger = await client.latestLedger();
  const underlying = stellar([
    "contract",
    "id",
    "asset",
    "--asset",
    "native",
    "--network",
    network,
  ]).stdout;
  let deployments: Record<string, { contractId: string; transactionHashes: string[] }>;
  if (existsSync(partialPath)) {
    deployments = JSON.parse(readFileSync(partialPath, "utf8"));
    console.log(`resuming contracts from ${partialPath}`);
  } else {
    deployments = {};
    deployments.confidentialVerifier = deploy(wasm.confidentialVerifier, ["--manager", roles.deployer]);
    deployments.confidentialAuditor = deploy(wasm.confidentialAuditor, ["--manager", roles.auditor]);
    deployments.confidentialToken = deploy(wasm.confidentialToken, [
      "--underlying_asset",
      underlying,
      "--verifier",
      deployments.confidentialVerifier.contractId,
      "--auditor",
      deployments.confidentialAuditor.contractId,
    ]);
    deployments.maxBidVerifier = deploy(wasm.maxBidVerifier, [
      "--verification_key-file-path",
      join(circuitsDir, "max_bid.vk.bin"),
    ]);
    deployments.eligibilityPolicy = deploy(wasm.eligibilityPolicy, ["--admin", roles.issuer]);
    deployments.rwaToken = deploy(wasm.rwaToken, [
      "--admin",
      roles.issuer,
      "--name",
      "QuietBook Demo Note",
      "--symbol",
      "QBNOTE",
    ]);
    deployments.market = deploy(wasm.market);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, `${JSON.stringify(deployments, null, 2)}\n`);
  }

  client.cfg.contracts = {
    token: deployments.confidentialToken.contractId,
    verifier: deployments.confidentialVerifier.contractId,
    auditor: deployments.confidentialAuditor.contractId,
  };
  const deployerSigner = keypairSigner(secret(source), Networks.TESTNET);
  const verifierTransactions: Record<string, string> = {};
  const circuits = [
    ["register", 0],
    ["withdraw", 1],
    ["transfer", 2],
    ["spender_transfer", 3],
    ["set_spender", 4],
    ["revoke_spender", 5],
  ] as const;
  for (const [name, circuitType] of circuits) {
    const key = readFileSync(join(circuitsDir, "vks", `${name}.vk.bin`));
    const result = await client.invoke(
      deployments.confidentialVerifier.contractId,
      "register_verification_key",
      [
        xdr.ScVal.scvU32(circuitType),
        xdr.ScVal.scvBytes(key),
        new Address(roles.deployer).toScVal(),
      ],
      deployerSigner,
    );
    verifierTransactions[name] = result.hash;
    console.log(`registered ${name} VK: ${result.hash}`);
  }

  const auditorSecret = randomScalar();
  const auditorPoint = scalarMul(auditorSecret, H);
  const auditorSigner = keypairSigner(secret(roleNames.auditor), Networks.TESTNET);
  const auditorRegistration = await client.invoke(
    deployments.confidentialAuditor.contractId,
    "register_key",
    [
      xdr.ScVal.scvU32(0),
      xdr.ScVal.scvBytes(Buffer.from(pointToBytes(auditorPoint))),
      new Address(roles.auditor).toScVal(),
    ],
    auditorSigner,
  );
  const endLedger = await client.latestLedger();
  const coords = pointCoords(auditorPoint);

  mkdirSync(dirname(privatePath), { recursive: true });
  writeFileSync(privatePath, `${JSON.stringify({ auditorSecretHex: toHex32(auditorSecret) }, null, 2)}\n`);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    network,
    rpcUrl,
    networkPassphrase: Networks.TESTNET,
    revisions: {
      stellarContracts: "98090b3e59785454f55b3617992c2f84250c7173",
      confidentialTokenDemo: "9500ed774b13b08b5fe99370b60de3479edb492b",
      ultraHonk: "5e9b4d995ec43ed1953cf89cfd738df6471e4b93",
      noir: "1.0.0-beta.9",
      barretenberg: "0.87.0",
    },
    ledgerRange: { start: startLedger, end: endLedger },
    roles,
    contracts: Object.fromEntries(
      Object.entries(deployments).map(([name, item]) => [
        name,
        {
          ...item,
          wasmSha256: sha256(wasm[name as keyof typeof wasm]),
          explorer: `https://stellar.expert/explorer/testnet/contract/${item.contractId}`,
        },
      ]),
    ),
    underlying,
    verificationKeys: Object.fromEntries(
      circuits.map(([name]) => [name, { sha256: sha256(join(circuitsDir, "vks", `${name}.vk.bin`)), transactionHash: verifierTransactions[name] }]),
    ),
    maxBidVerificationKey: { sha256: sha256(join(circuitsDir, "max_bid.vk.bin")) },
    auditor: {
      id: 0,
      publicKey: { x: toHex32(coords.x), y: toHex32(coords.y) },
      registrationTransactionHash: auditorRegistration.hash,
    },
    limitations: ["Unaudited Testnet-only prototype", "No production or mainnet value"],
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
