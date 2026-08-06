import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";

function findRoot() {
  if (process.env.QUIETBOOK_ROOT) return process.env.QUIETBOOK_ROOT;
  let candidate = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(candidate, "docs/evidence/testnet/deployment.json"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("Could not locate the QuietBook application root");
    candidate = parent;
  }
}

function evidence(name: string) {
  return JSON.parse(readFileSync(join(root, "docs/evidence/testnet", name), "utf8"));
}

export const root = findRoot();
export const deployment = evidence("deployment.json");
const controller = evidence("controller-smoke.json");
const withdrawal = evidence("withdrawal.json");
export const rpcUrl = deployment.rpcUrl;
export const startLedger = deployment.ledgerRange.start;
export const marketContracts = [
  deployment.contracts.market.contractId,
  deployment.liveMarket.contractId,
  withdrawal.market,
];
export const contractGroups: Record<string, string[]> = {
  core: [
    ...marketContracts,
    deployment.contracts.confidentialToken.contractId,
    deployment.contracts.rwaToken.contractId,
  ],
  infrastructure: [
    deployment.contracts.eligibilityPolicy.contractId,
    deployment.contracts.confidentialAuditor.contractId,
    controller.controller,
    withdrawal.controller,
  ],
};

export const defaultDatabasePath = join(root, ".quietbook/indexer.sqlite");
export const indexerHost = process.env.QUIETBOOK_INDEXER_HOST ?? "127.0.0.1";
export const indexerPort = Number(process.env.QUIETBOOK_INDEXER_PORT ?? 8787);
export const sandboxStatePath = process.env.QUIETBOOK_SANDBOX_STATE
  ?? join(root, ".quietbook/live-sandbox-private.json");
export const controllerWasmPath = process.env.QUIETBOOK_CONTROLLER_WASM
  ?? join(root, "contracts/target/wasm32v1-none/release/quietbook_round_controller.wasm");
export const stellarBin = process.env.QUIETBOOK_STELLAR_BIN ?? "stellar";
export const allowedOrigins = (process.env.QUIETBOOK_ALLOWED_ORIGINS
  ?? "http://127.0.0.1:5173,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
export const authAudience = process.env.QUIETBOOK_AUTH_AUDIENCE ?? "quietbook-local-indexer";
export const sessionSecret = process.env.QUIETBOOK_SESSION_SECRET
  ?? "quietbook-local-development-session-secret";

const identityVariables = {
  "quietbook-deployer": "QUIETBOOK_DEPLOYER_SECRET",
  "quietbook-issuer": "QUIETBOOK_ISSUER_SECRET",
  "quietbook-operator": "QUIETBOOK_OPERATOR_SECRET",
} as const;

export function identitySecret(identity: keyof typeof identityVariables) {
  return process.env[identityVariables[identity]];
}

export function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.QUIETBOOK_SESSION_SECRET || process.env.QUIETBOOK_SESSION_SECRET.length < 32) {
    throw new Error("Production requires QUIETBOOK_SESSION_SECRET with at least 32 characters");
  }
  if (!process.env.QUIETBOOK_ALLOWED_ORIGINS) throw new Error("Production requires QUIETBOOK_ALLOWED_ORIGINS");
  if (!process.env.QUIETBOOK_AUTH_AUDIENCE) throw new Error("Production requires QUIETBOOK_AUTH_AUDIENCE");
  const expected = {
    "quietbook-deployer": deployment.roles.deployer,
    "quietbook-issuer": deployment.roles.issuer,
    "quietbook-operator": deployment.roles.operator,
  } as const;
  for (const identity of Object.keys(identityVariables) as Array<keyof typeof identityVariables>) {
    const value = identitySecret(identity);
    if (!value) throw new Error(`Production requires ${identityVariables[identity]}`);
    if (Keypair.fromSecret(value).publicKey() !== expected[identity]) {
      throw new Error(`${identityVariables[identity]} does not match the deployed Testnet role`);
    }
  }
}
export const evidenceFiles = [
  "deployment.json",
  "register-smoke.json",
  "controller-smoke.json",
  "round-setup.json",
  "settlement.json",
  "reclaim.json",
  "withdrawal.json",
  "audit.json",
  "disclosure.json",
  "negative-tests.json",
] as const;
