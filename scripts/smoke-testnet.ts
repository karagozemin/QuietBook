import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Networks } from "@stellar/stellar-sdk";
import {
  ChainClient,
  addressToField,
  deriveKeys,
  keypairSigner,
  proverFromArtifact,
  randomScalar,
  submitRegister,
  toHex32,
} from "@ctd/sdk";
import { buildAccountBoundRegisterWitness } from "../packages/sdk/src/index.js";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentPath = join(root, "docs/evidence/testnet/deployment.json");
const evidencePath = join(root, "docs/evidence/testnet/register-smoke.json");
const privatePath = join(root, ".quietbook/testnet-smoke-private.json");

function stellar(args: string[]): string {
  return execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const token = deployment.contracts.confidentialToken.contractId as string;
  const issuer = deployment.roles.issuer as string;
  const keys = deriveKeys(randomScalar(), addressToField(token));
  const artifact = JSON.parse(
    readFileSync(join(root, "packages/sdk/circuits/register.json"), "utf8"),
  );
  const prover = proverFromArtifact(artifact);
  try {
    const witness = buildAccountBoundRegisterWitness(keys, issuer);
    const generated = await prover.prove(witness.inputs);
    const client = new ChainClient({
      rpcUrl: deployment.rpcUrl,
      networkPassphrase: Networks.TESTNET,
      contracts: {
        token,
        verifier: deployment.contracts.confidentialVerifier.contractId,
        auditor: deployment.contracts.confidentialAuditor.contractId,
      },
    });
    const signer = keypairSigner(stellar(["keys", "show", "quietbook-issuer"]), Networks.TESTNET);
    const result = await submitRegister(client, signer, issuer, 0, witness, generated.proof);
    const evidence = {
      generatedAt: new Date().toISOString(),
      account: issuer,
      token,
      transactionHash: result.hash,
      explorer: `https://stellar.expert/explorer/testnet/tx/${result.hash}`,
      proofBytes: generated.proof.length,
      proofSha256: createHash("sha256").update(generated.proof).digest("hex"),
      circuitArtifactSha256: createHash("sha256")
        .update(readFileSync(join(root, "packages/sdk/circuits/register.json")))
        .digest("hex"),
    };
    mkdirSync(dirname(privatePath), { recursive: true });
    writeFileSync(privatePath, `${JSON.stringify({ issuerConfidentialSk: toHex32(keys.sk) }, null, 2)}\n`);
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`register proof accepted on Testnet: ${result.hash}`);
  } finally {
    await prover.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
