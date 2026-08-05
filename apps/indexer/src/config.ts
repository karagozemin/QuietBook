import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import deployment from "../../../docs/evidence/testnet/deployment.json" with { type: "json" };
import controller from "../../../docs/evidence/testnet/controller-smoke.json" with { type: "json" };
import withdrawal from "../../../docs/evidence/testnet/withdrawal.json" with { type: "json" };

export const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
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
