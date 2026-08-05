import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Address, Networks, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  ChainClient,
  addressToField,
  deriveKeys,
  fromBytesBE,
  keypairSigner,
  proverFromArtifact,
  randomScalar,
} from "@ctd/sdk";
import {
  buildAccountBoundRegisterWitness,
  buildMaxBidWitness,
  buildSpenderTransferWitness,
  encodeRegisterData,
  encodeSpenderTransferData,
} from "@quietbook/sdk";
import deployment from "../../../docs/evidence/testnet/deployment.json" with { type: "json" };
import { root } from "./config.js";

type ReceiptMap = Record<string, string>;
type BidOpening = {
  account: string;
  value: string;
  randomness: string;
  dvk: string;
  sigmaA: string;
  delegationTransaction: string;
  registrationTransaction: string;
};
type PendingRound = {
  setupId: string;
  issuer: string;
  controller: string;
  controllerSk: string;
  bidDeadlineLedger: number;
  settlementDeadlineLedger: number;
  registerDataXdr: string;
  receipts: ReceiptMap;
};
type SandboxRound = PendingRound & {
  roundId: string;
  createdAt: string;
  receipts: ReceiptMap;
  bids: Record<string, BidOpening>;
  proof?: { hash: string; bytes: number };
  winner?: string;
};
type SandboxState = {
  pending: Record<string, PendingRound>;
  rounds: Record<string, SandboxRound>;
};

const statePath = join(root, ".quietbook/live-sandbox-private.json");
const controllerWasm = join(root, "contracts/target/wasm32v1-none/release/quietbook_round_controller.wasm");
const registerArtifact = JSON.parse(readFileSync(join(root, "packages/sdk/circuits/register.json"), "utf8"));
const transferArtifact = JSON.parse(readFileSync(join(root, "packages/sdk/circuits/spender_transfer.json"), "utf8"));
const maxBidArtifact = JSON.parse(readFileSync(join(root, "packages/sdk/circuits/max_bid.json"), "utf8"));
const RESERVE = 80_000_000n;
const RWA_LOT = 10_000_000n;

function readState(): SandboxState {
  if (!existsSync(statePath)) return { pending: {}, rounds: {} };
  return JSON.parse(readFileSync(statePath, "utf8")) as SandboxState;
}

function saveState(state: SandboxState) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function stellar(args: string[]) {
  const result = spawnSync("stellar", args, { encoding: "utf8" });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error("Controller deployment failed on Testnet");
  return {
    stdout: result.stdout.trim(),
    hashes: [...combined.matchAll(/\/tx\/([0-9a-f]{64})/g)].map((match) => match[1]!),
  };
}

function secret(identity: string) {
  const result = spawnSync("stellar", ["keys", "show", identity], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim().startsWith("S")) {
    throw new Error(`Missing local Testnet identity: ${identity}`);
  }
  return result.stdout.trim();
}

function client() {
  return new ChainClient({
    rpcUrl: deployment.rpcUrl,
    networkPassphrase: Networks.TESTNET,
    contracts: {
      token: deployment.contracts.confidentialToken.contractId,
      verifier: deployment.contracts.confidentialVerifier.contractId,
      auditor: deployment.contracts.confidentialAuditor.contractId,
    },
  });
}

function bytes32(value: string) {
  return xdr.ScVal.scvBytes(Buffer.from(value, "hex"));
}

function publicRound(round: SandboxRound) {
  return {
    roundId: round.roundId,
    issuer: round.issuer,
    controller: round.controller,
    bidDeadlineLedger: round.bidDeadlineLedger,
    settlementDeadlineLedger: round.settlementDeadlineLedger,
    createdAt: round.createdAt,
    bidders: Object.keys(round.bids),
    receipts: round.receipts,
    winner: round.winner ?? null,
    proof: round.proof ?? null,
  };
}

export class LiveSandbox {
  private queue: Promise<unknown> = Promise.resolve();

  list() {
    return Object.values(readState().rounds)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicRound);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  prepareRound(issuer: string) {
    return this.exclusive(async () => {
      new Address(issuer);
      const chain = client();
      if (!(await chain.isRegistered(issuer))) {
        throw new Error("Initialize the issuer confidential account first");
      }
      const latestLedger = await chain.latestLedger();
      const bidDeadlineLedger = latestLedger + 180;
      const settlementDeadlineLedger = latestLedger + 300;
      const deployed = stellar([
        "contract", "deploy", "--wasm", controllerWasm,
        "--source", "quietbook-deployer", "--network", "testnet", "--optimize=false", "--",
        "--market", deployment.contracts.market.contractId,
        "--confidential_token", deployment.contracts.confidentialToken.contractId,
        "--issuer_recipient", issuer,
        "--settlement_deadline_ledger", String(settlementDeadlineLedger),
      ]);
      const controller = deployed.stdout.split(/\s+/).reverse().find((value: string) => value.startsWith("C"));
      if (!controller) throw new Error("Controller id was not returned by Stellar CLI");

      const controllerKeys = deriveKeys(randomScalar(), addressToField(deployment.contracts.confidentialToken.contractId));
      const witness = buildAccountBoundRegisterWitness(controllerKeys, controller);
      const prover = proverFromArtifact(registerArtifact);
      let generated;
      try {
        generated = await prover.prove(witness.inputs);
      } finally {
        await prover.destroy();
      }
      const registerData = encodeRegisterData(witness, generated.proof);
      const admin = keypairSigner(secret("quietbook-issuer"), Networks.TESTNET);
      const minted = await chain.invoke(
        deployment.contracts.rwaToken.contractId,
        "mint",
        [new Address(issuer).toScVal(), nativeToScVal(RWA_LOT, { type: "i128" })],
        admin,
      );
      const setupId = randomUUID();
      const pending: PendingRound = {
        setupId,
        issuer,
        controller,
        controllerSk: `0x${controllerKeys.sk.toString(16).padStart(64, "0")}`,
        bidDeadlineLedger,
        settlementDeadlineLedger,
        registerDataXdr: registerData.toXDR("base64"),
        receipts: {
          controllerDeploy: deployed.hashes.at(-1) ?? "",
          rwaMint: minted.hash,
          controllerRegisterProof: createHash("sha256").update(generated.proof).digest("hex"),
        },
      };
      const state = readState();
      state.pending[setupId] = pending;
      saveState(state);
      return {
        setupId,
        registerDataXdr: pending.registerDataXdr,
        config: {
          issuer,
          rwaToken: deployment.contracts.rwaToken.contractId,
          rwaLot: RWA_LOT.toString(),
          confidentialToken: deployment.contracts.confidentialToken.contractId,
          controller,
          eligibilityPolicy: deployment.contracts.eligibilityPolicy.contractId,
          maxBidVerifier: deployment.contracts.maxBidVerifier.contractId,
          auditorId: 0,
          reservePublic: RESERVE.toString(),
          bidDeadlineLedger,
          settlementDeadlineLedger,
        },
        receipts: pending.receipts,
      };
    });
  }

  activate(input: { setupId: string; roundId: string; receipts: ReceiptMap }) {
    const state = readState();
    const pending = state.pending[input.setupId];
    if (!pending || !/^[0-9a-f]{64}$/i.test(input.roundId)) throw new Error("Unknown round preparation");
    const round: SandboxRound = {
      ...pending,
      roundId: input.roundId,
      createdAt: new Date().toISOString(),
      receipts: { ...pending.receipts, ...input.receipts },
      bids: {},
    };
    state.rounds[round.roundId] = round;
    delete state.pending[input.setupId];
    saveState(state);
    return publicRound(round);
  }

  allowlist(roundId: string, account: string) {
    return this.exclusive(async () => {
      const state = readState();
      if (!state.rounds[roundId]) throw new Error("Live round not found");
      new Address(account);
      const result = await client().invoke(
        deployment.contracts.eligibilityPolicy.contractId,
        "set_authorized",
        [new Address(account).toScVal(), xdr.ScVal.scvBool(true)],
        keypairSigner(secret("quietbook-issuer"), Networks.TESTNET),
      );
      return { transaction: result.hash };
    });
  }

  recordBid(roundId: string, opening: BidOpening) {
    const state = readState();
    const round = state.rounds[roundId];
    if (!round) throw new Error("Live round not found");
    if (Object.keys(round.bids).length >= 3 && !round.bids[opening.account]) throw new Error("Round capacity reached");
    new Address(opening.account);
    for (const value of [opening.value, opening.randomness, opening.dvk, opening.sigmaA]) BigInt(value);
    round.bids[opening.account] = opening;
    round.receipts[`bid:${opening.account}`] = opening.registrationTransaction;
    saveState(state);
    return { accepted: true };
  }

  settle(roundId: string) {
    return this.exclusive(async () => {
      const state = readState();
      const round = state.rounds[roundId];
      if (!round) throw new Error("Live round not found");
      const chain = client();
      const operator = keypairSigner(secret("quietbook-operator"), Networks.TESTNET);
      const latest = await chain.latestLedger();
      if (latest <= round.bidDeadlineLedger) {
        throw new Error(`Bid window is still open for ${round.bidDeadlineLedger - latest} ledgers`);
      }
      if (!round.receipts.closeRound) {
        round.receipts.closeRound = (await chain.invoke(
          deployment.contracts.market.contractId,
          "close_round",
          [bytes32(roundId)],
          operator,
        )).hash;
        saveState(state);
      }
      const biddersValue = await chain.simulate(deployment.contracts.market.contractId, "get_bidders", [bytes32(roundId)]);
      const bidders = (await import("@stellar/stellar-sdk")).scValToNative(biddersValue) as string[];
      if (bidders.length === 0) throw new Error("No active bids to settle");
      const openings = bidders.map((account) => round.bids[account]);
      if (openings.some((opening) => !opening)) throw new Error("A private bid opening is missing from the operator vault");
      const winnerIndex = openings.reduce(
        (winner, opening, index) => BigInt(opening!.value) > BigInt(openings[winner]!.value) ? index : winner,
        0,
      );
      const winner = openings[winnerIndex]!;
      const tokenAddressField = addressToField(deployment.contracts.confidentialToken.contractId);
      const controllerKeys = deriveKeys(BigInt(round.controllerSk), tokenAddressField);
      const issuerAccount = await chain.confidentialBalance(round.issuer);
      if (!issuerAccount) throw new Error("Issuer confidential account is unavailable");
      const auditorKey = await chain.auditorKey(0);
      const transferWitness = buildSpenderTransferWitness({
        spenderKeys: controllerKeys,
        delegationDvk: BigInt(winner.dvk),
        allowance: BigInt(winner.value),
        allowanceRandomness: BigInt(winner.randomness),
        allowanceSalt: BigInt(winner.sigmaA),
        amount: BigInt(winner.value),
        recipientViewingKey: issuerAccount.viewingPublicKey,
        recipientAuditorKey: auditorKey,
        ownerAuditorKey: auditorKey,
      });
      const transferProver = proverFromArtifact(transferArtifact);
      const maxBidProver = proverFromArtifact(maxBidArtifact);
      try {
        const transferProof = await transferProver.prove(transferWitness.inputs);
        const transferData = encodeSpenderTransferData(transferWitness, transferProof.proof);
        const statement = await chain.simulate(deployment.contracts.market.contractId, "max_bid_public_inputs", [
          bytes32(roundId), xdr.ScVal.scvU32(winnerIndex), transferData,
        ]);
        const statementBytes = Buffer.from(statement.bytes());
        const witness = buildMaxBidWitness({
          roundDomain: fromBytesBE(statementBytes.subarray(0, 32)),
          bids: openings.map((opening) => ({ value: BigInt(opening!.value), randomness: BigInt(opening!.randomness) })),
          reserve: RESERVE,
          payment: transferWitness.paymentOpening,
        });
        const maxBidProof = await maxBidProver.prove(witness.inputs);
        const publicInputs = Buffer.concat(maxBidProof.publicInputs.map((value) => Buffer.from(value.replace(/^0x/, "").padStart(64, "0"), "hex")));
        if (!publicInputs.equals(statementBytes)) throw new Error("Max-bid statement mismatch");
        const finalized = await chain.invoke(
          deployment.contracts.market.contractId,
          "finalize",
          [bytes32(roundId), xdr.ScVal.scvU32(winnerIndex), nativeToScVal(maxBidProof.proof, { type: "bytes" }), transferData],
          operator,
        );
        round.receipts.finalize = finalized.hash;
        round.winner = winner.account;
        round.proof = {
          hash: createHash("sha256").update(maxBidProof.proof).digest("hex"),
          bytes: maxBidProof.proof.length,
        };
        saveState(state);
        return publicRound(round);
      } finally {
        await Promise.all([transferProver.destroy(), maxBidProver.destroy()]);
      }
    });
  }
}

export type { BidOpening };
