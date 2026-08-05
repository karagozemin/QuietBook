import {
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import { testnetEvidence } from "./evidence";

type NativeRound = {
  bidder_count: number;
  config: {
    controller: string;
    confidential_token: string;
  };
  id: Uint8Array;
  proof_hash: Uint8Array;
  status: string[];
  winner: string;
  rwa_escrowed: boolean;
};

export type LiveCheck = {
  label: string;
  matched: boolean;
};

export type LiveSnapshot = {
  latestLedger: number;
  checkedAt: string;
  checks: LiveCheck[];
  matchedCount: number;
  allMatched: boolean;
};

const bytesFromHex = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));

const hexFromBytes = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function simulateValue(
  server: rpc.Server,
  source: Awaited<ReturnType<rpc.Server["getAccount"]>>,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
) {
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`Simulation failed for ${method}`);
  }
  return {
    latestLedger: simulation.latestLedger,
    value: scValToNative(simulation.result.retval) as unknown,
  };
}

export async function verifyLiveTestnet(): Promise<LiveSnapshot> {
  const { deployment, controller, settlement, setup } = testnetEvidence;
  const server = new rpc.Server(deployment.rpcUrl);
  const source = await server.getAccount(deployment.roles.issuer);
  const roundId = nativeToScVal(bytesFromHex(settlement.roundId), { type: "bytes" });

  const [roundResult, biddersResult, controllerResult, transaction] = await Promise.all([
    simulateValue(server, source, deployment.contracts.market.contractId, "get_round", [roundId]),
    simulateValue(server, source, deployment.contracts.market.contractId, "get_bidders", [roundId]),
    simulateValue(server, source, controller.controller, "configuration"),
    server.getTransaction(settlement.finalizeTransaction),
  ]);

  const round = roundResult.value as NativeRound;
  const bidders = biddersResult.value as string[];
  const configuration = controllerResult.value as [string, string, string, number, boolean];
  const status = Array.isArray(round.status) ? round.status[0] : round.status;
  const checks: LiveCheck[] = [
    { label: "Round settled", matched: status === settlement.readBack.roundStatus },
    { label: "Winner matched", matched: round.winner === settlement.winner },
    {
      label: "Proof hash matched",
      matched: hexFromBytes(round.proof_hash) === settlement.maxBidProof.sha256,
    },
    {
      label: "Participant set matched",
      matched:
        round.bidder_count === setup.bidderAccounts.length &&
        bidders.join(":") === setup.bidderAccounts.join(":"),
    },
    {
      label: "Controller registered",
      matched:
        configuration[0] === deployment.contracts.market.contractId &&
        configuration[1] === deployment.contracts.confidentialToken.contractId &&
        configuration[4] === true &&
        round.config.controller === controller.controller,
    },
    {
      label: "Settlement receipt confirmed",
      matched:
        transaction.status === "SUCCESS" && transaction.txHash === settlement.finalizeTransaction,
    },
    {
      label: "Round identity matched",
      matched:
        hexFromBytes(round.id) === settlement.roundId &&
        round.rwa_escrowed === true &&
        round.config.confidential_token === deployment.contracts.confidentialToken.contractId,
    },
  ];
  const matchedCount = checks.filter((check) => check.matched).length;

  return {
    latestLedger: Math.max(
      roundResult.latestLedger,
      biddersResult.latestLedger,
      controllerResult.latestLedger,
      transaction.latestLedger,
    ),
    checkedAt: new Date().toISOString(),
    checks,
    matchedCount,
    allMatched: matchedCount === checks.length,
  };
}
