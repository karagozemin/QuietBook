import {
  BASE_FEE,
  Address,
  Contract,
  Keypair,
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
  indexer: "verified" | "unavailable";
};

type IndexedRoundResponse = {
  round: {
    roundId: string;
    marketId: string;
    status: string;
    bidderCount: number;
    winner: string | null;
    proofHash: string | null;
  };
  events: Array<{ eventType: string; txHash: string }>;
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

async function indexedRound(roundId: string): Promise<IndexedRoundResponse | null> {
  const baseUrl = import.meta.env.VITE_INDEXER_URL;
  if (!baseUrl) return null;
  try {
    const response = await fetch(`${baseUrl}/api/rounds/${roundId}`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    return (await response.json()) as IndexedRoundResponse;
  } catch {
    return null;
  }
}

export async function verifyLiveTestnet(): Promise<LiveSnapshot> {
  const { deployment, controller, settlement, setup } = testnetEvidence;
  const server = new rpc.Server(deployment.rpcUrl);
  const source = await server.getAccount(deployment.roles.issuer);
  const roundId = nativeToScVal(bytesFromHex(settlement.roundId), { type: "bytes" });
  const indexed = await indexedRound(settlement.roundId);

  const [
    roundResult,
    biddersResult,
    controllerResult,
    transaction,
    reclaimStates,
    withdrawalRound,
    withdrawalBid,
    withdrawalDelegated,
    auditorKey,
  ] = await Promise.all([
    simulateValue(server, source, deployment.contracts.market.contractId, "get_round", [roundId]),
    simulateValue(server, source, deployment.contracts.market.contractId, "get_bidders", [roundId]),
    simulateValue(server, source, controller.controller, "configuration"),
    server.getTransaction(settlement.finalizeTransaction),
    Promise.all(
      testnetEvidence.reclaim.losingBidderReclaims.map(async ({ account }) => {
        const result = await simulateValue(
          server,
          source,
          deployment.contracts.confidentialToken.contractId,
          "is_spender",
          [new Address(account).toScVal(), new Address(controller.controller).toScVal()],
        );
        return result.value === false;
      }),
    ),
    simulateValue(
      server,
      source,
      testnetEvidence.withdrawal.market,
      "get_round",
      [nativeToScVal(bytesFromHex(testnetEvidence.withdrawal.roundId), { type: "bytes" })],
    ),
    simulateValue(
      server,
      source,
      testnetEvidence.withdrawal.market,
      "get_bid",
      [
        nativeToScVal(bytesFromHex(testnetEvidence.withdrawal.roundId), { type: "bytes" }),
        new Address(testnetEvidence.withdrawal.bidder).toScVal(),
      ],
    ),
    simulateValue(
      server,
      source,
      deployment.contracts.confidentialToken.contractId,
      "is_spender",
      [
        new Address(testnetEvidence.withdrawal.bidder).toScVal(),
        new Address(testnetEvidence.withdrawal.controller).toScVal(),
      ],
    ),
    simulateValue(
      server,
      source,
      deployment.contracts.confidentialAuditor.contractId,
      "get_key",
      [nativeToScVal(testnetEvidence.audit.auditor.id, { type: "u32" })],
    ),
  ]);

  const round = roundResult.value as NativeRound;
  const bidders = biddersResult.value as string[];
  const configuration = controllerResult.value as [string, string, string, number, boolean];
  const auditorPoint = `${deployment.auditor.publicKey.x.replace(/^0x/, "")}${deployment.auditor.publicKey.y.replace(/^0x/, "")}`;
  const auditHash = bytesFromHex(testnetEvidence.audit.exportIntegrity.canonicalPayloadSha256);
  const auditSignature = Uint8Array.from(atob(testnetEvidence.audit.exportIntegrity.signature), (character) => character.charCodeAt(0));
  const status = Array.isArray(round.status) ? round.status[0] : round.status;
  const checks: LiveCheck[] = [
    ...(indexed
      ? [{
          label: "Indexer round matched",
          matched:
            indexed.round.roundId === settlement.roundId &&
            indexed.round.marketId === deployment.contracts.market.contractId &&
            indexed.round.status === settlement.readBack.roundStatus &&
            indexed.round.bidderCount === setup.bidderAccounts.length &&
            indexed.round.winner === settlement.winner &&
            indexed.round.proofHash === settlement.maxBidProof.sha256 &&
            indexed.events.some(
              (event) =>
                event.eventType === "round_settled" &&
                event.txHash === settlement.finalizeTransaction,
            ),
        }]
      : []),
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
    {
      label: "Losing bids reclaimed",
      matched: reclaimStates.length === 2 && reclaimStates.every(Boolean),
    },
    {
      label: "Bid withdrawal verified",
      matched:
        (withdrawalRound.value as { bidder_count: number }).bidder_count === 0 &&
        (withdrawalBid.value as { active: boolean }).active === false &&
        withdrawalDelegated.value === false,
    },
    {
      label: "Auditor registry key matched",
      matched:
        hexFromBytes(auditorKey.value as Uint8Array) === auditorPoint &&
        testnetEvidence.audit.auditor.rotationCount === 0,
    },
    {
      label: "Audit export signature verified",
      matched:
        Keypair.fromPublicKey(testnetEvidence.audit.exportIntegrity.signer)
          .verify(auditHash as Buffer, auditSignature as Buffer) &&
        testnetEvidence.audit.eventVerification.directRpcXdrMatches &&
        testnetEvidence.audit.eventVerification.settlementLinkageVerified,
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
    indexer: indexed ? "verified" : "unavailable",
  };
}
