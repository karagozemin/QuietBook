import deployment from "../../../docs/evidence/testnet/deployment.json";
import controller from "../../../docs/evidence/testnet/controller-smoke.json";
import setup from "../../../docs/evidence/testnet/round-setup.json";
import settlement from "../../../docs/evidence/testnet/settlement.json";

export const testnetEvidence = { deployment, controller, setup, settlement };

export const participants = setup.bidderAccounts.map((account, index) => ({
  alias: `Demo Investor ${String(index + 1).padStart(2, "0")}`,
  account,
  registrationIndex: index,
  winner: account === settlement.winner,
  registrationTransaction: setup.bidderTransactions[index]?.registerBid ?? "",
}));

export const explorerTransaction = (hash: string) =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`;

export const explorerContract = (contractId: string) =>
  `https://stellar.expert/explorer/testnet/contract/${contractId}`;

export function compact(value: string, head = 7, tail = 5) {
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}
