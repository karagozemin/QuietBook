import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import initAcvm from "@noir-lang/acvm_js";
import acvmWasmUrl from "@noir-lang/acvm_js/web/acvm_js_bg.wasm?url";
import initNoircAbi from "@noir-lang/noirc_abi";
import noircAbiWasmUrl from "@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm?url";
import {
  addressToField,
  deriveKeys,
  pointFromBytes,
  proverFromArtifact,
  randomScalar,
  setUltraHonkBackendLoader,
} from "@ctd/sdk";
import {
  buildAccountBoundRegisterWitness,
  buildRevokeSpenderWitness,
  buildSetSpenderWitness,
  encodeRegisterData,
  encodeRevokeSpenderData,
  encodeSetSpenderData,
  parseConfidentialAccount,
} from "@quietbook/sdk";
import registerArtifact from "../../../packages/sdk/circuits/register.json";
import setSpenderArtifact from "../../../packages/sdk/circuits/set_spender.json";
import revokeSpenderArtifact from "../../../packages/sdk/circuits/revoke_spender.json";
import { testnetEvidence } from "./evidence";
import { freighterSigner, productClient, type WalletSession } from "./wallet";

const API = import.meta.env.VITE_INDEXER_URL ?? "http://127.0.0.1:8787";
const DEPOSIT = 200_000_000n;
const MIN_BID = 80_000_000n;
const TOKEN = testnetEvidence.deployment.contracts.confidentialToken.contractId;

type LocalDelegation = {
  value: string;
  randomness: string;
  dvk: string;
  sigmaA: string;
};
type LocalConfidentialState = {
  secret: string;
  spendableValue: string;
  spendableRandomness: string;
  delegations: Record<string, LocalDelegation>;
};
export type SandboxRound = {
  roundId: string;
  issuer: string;
  controller: string;
  bidDeadlineLedger: number;
  settlementDeadlineLedger: number;
  createdAt: string;
  bidders: string[];
  receipts: Record<string, string>;
  winner: string | null;
  proof: { hash: string; bytes: number } | null;
};
type PreparedRound = {
  setupId: string;
  registerDataXdr: string;
  config: {
    issuer: string;
    rwaToken: string;
    rwaLot: string;
    confidentialToken: string;
    controller: string;
    eligibilityPolicy: string;
    maxBidVerifier: string;
    auditorId: number;
    reservePublic: string;
    bidDeadlineLedger: number;
    settlementDeadlineLedger: number;
  };
};

let proverLoaderConfigured = false;
let noirRuntime: Promise<unknown> | null = null;
async function configureBrowserProver() {
  if (!proverLoaderConfigured) {
    const moduleUrl = "/bb/index.js";
    setUltraHonkBackendLoader(async () => {
      const module = await import(/* @vite-ignore */ moduleUrl) as { UltraHonkBackend: never };
      return module.UltraHonkBackend;
    });
    proverLoaderConfigured = true;
  }
  noirRuntime ??= Promise.all([
    initAcvm(acvmWasmUrl),
    initNoircAbi(noircAbiWasmUrl),
  ]);
  await noirRuntime;
}

function storageKey(account: string) {
  return `quietbook:confidential:${TOKEN}:${account}`;
}

function loadLocal(account: string): LocalConfidentialState | null {
  const value = localStorage.getItem(storageKey(account));
  return value ? JSON.parse(value) as LocalConfidentialState : null;
}

function saveLocal(account: string, value: LocalConfidentialState) {
  localStorage.setItem(storageKey(account), JSON.stringify(value));
}

function deploymentAuditorKey() {
  const auditor = testnetEvidence.deployment.auditor.publicKey;
  return pointFromBytes(Uint8Array.from(
    `${auditor.x.replace(/^0x/, "")}${auditor.y.replace(/^0x/, "")}`.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  ));
}

async function api<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, input === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Sandbox request failed (${response.status})`);
  return result;
}

export async function listSandboxRounds(): Promise<SandboxRound[]> {
  return (await api<{ rounds: SandboxRound[] }>("/api/sandbox/rounds")).rounds;
}

export async function initializeConfidentialAccount(session: WalletSession, requireLocalState = true) {
  const client = productClient();
  let registered = false;
  try {
    await client.chain.simulate(TOKEN, "confidential_balance", [new Address(session.address).toScVal()]);
    registered = true;
  } catch {
    registered = false;
  }
  const existing = loadLocal(session.address);
  if (registered) {
    if (!existing && requireLocalState) throw new Error("This account is registered, but its confidential key is not in this browser");
    return { transaction: "", created: false };
  }

  await configureBrowserProver();
  const secret = randomScalar();
  const keys = deriveKeys(secret, addressToField(TOKEN));
  const witness = buildAccountBoundRegisterWitness(keys, session.address);
  const prover = proverFromArtifact(registerArtifact);
  try {
    const proof = await prover.prove(witness.inputs);
    const result = await client.chain.invoke(
      TOKEN,
      "register",
      [new Address(session.address).toScVal(), xdr.ScVal.scvU32(0), encodeRegisterData(witness, proof.proof)],
      freighterSigner(session),
    );
    saveLocal(session.address, {
      secret: `0x${secret.toString(16).padStart(64, "0")}`,
      spendableValue: "0",
      spendableRandomness: "0",
      delegations: {},
    });
    return { transaction: result.hash, created: true };
  } finally {
    await prover.destroy();
  }
}

export async function createSandboxRound(session: WalletSession) {
  await initializeConfidentialAccount(session, false);
  const prepared = await api<PreparedRound>("/api/sandbox/prepare", { issuer: session.address });
  const client = productClient();
  const signer = freighterSigner(session);
  const created = await client.createRound({
    ...prepared.config,
    rwaLot: BigInt(prepared.config.rwaLot),
    reservePublic: BigInt(prepared.config.reservePublic),
  }, signer);
  const registered = await client.registerController(
    created.roundId,
    prepared.config.auditorId,
    xdr.ScVal.fromXDR(prepared.registerDataXdr, "base64"),
    signer,
  );
  const opened = await client.fundAndOpen(created.roundId, signer);
  return api<SandboxRound>("/api/sandbox/activate", {
    setupId: prepared.setupId,
    roundId: created.roundId,
    receipts: {
      createRound: created.transaction,
      registerController: registered.hash,
      fundRound: opened.fundTransaction,
      openRound: opened.openTransaction,
    },
  });
}

export async function submitSandboxBid(session: WalletSession, round: SandboxRound, bid: bigint) {
  if (bid < MIN_BID || bid > DEPOSIT) throw new Error("Bid must be between 8 and 20 XLM");
  await initializeConfidentialAccount(session);
  const local = loadLocal(session.address);
  if (!local) throw new Error("Confidential state is unavailable in this browser");
  await api<{ transaction: string }>("/api/sandbox/allowlist", { roundId: round.roundId, account: session.address });

  const client = productClient();
  const signer = freighterSigner(session);
  let spendableValue = BigInt(local.spendableValue);
  let spendableRandomness = BigInt(local.spendableRandomness);
  const depositReceipts: Record<string, string> = {};
  if (spendableValue < DEPOSIT) {
    const deposited = await client.chain.invoke(
      TOKEN,
      "deposit",
      [new Address(session.address).toScVal(), new Address(session.address).toScVal(), nativeToScVal(DEPOSIT, { type: "i128" })],
      signer,
    );
    const merged = await client.chain.invoke(TOKEN, "merge", [new Address(session.address).toScVal()], signer);
    spendableValue += DEPOSIT;
    depositReceipts.deposit = deposited.hash;
    depositReceipts.merge = merged.hash;
  }

  await configureBrowserProver();
  const accountValue = await client.chain.simulate(TOKEN, "confidential_balance", [new Address(round.controller).toScVal()]);
  const controllerAccount = parseConfidentialAccount(accountValue);
  const ownerKeys = deriveKeys(BigInt(local.secret), addressToField(TOKEN));
  const placeholder = deriveKeys(1n, addressToField(TOKEN));
  const spenderKeys = { ...placeholder, Y: pointFromBytes(controllerAccount.spendingPublicKey) };
  const auditorKey = deploymentAuditorKey();
  const witness = buildSetSpenderWitness({
    ownerKeys,
    spendableValue,
    spendableRandomness,
    allowance: bid,
    spenderKeys,
    spenderId: addressToField(round.controller),
    ownerAuditorKey: auditorKey,
  });
  const prover = proverFromArtifact(setSpenderArtifact);
  try {
    const generated = await prover.prove(witness.inputs);
    const delegated = await client.chain.invoke(
      TOKEN,
      "set_spender",
      [
        new Address(session.address).toScVal(),
        new Address(round.controller).toScVal(),
        xdr.ScVal.scvU32(round.settlementDeadlineLedger),
        encodeSetSpenderData(witness, generated.proof),
      ],
      signer,
    );
    local.spendableValue = witness.nextSpendable.value.toString();
    local.spendableRandomness = witness.nextSpendable.randomness.toString();
    local.delegations[round.roundId] = {
      value: witness.delegation.value.toString(),
      randomness: witness.delegation.randomness.toString(),
      dvk: witness.delegation.dvk.toString(),
      sigmaA: witness.delegation.sigmaA.toString(),
    };
    saveLocal(session.address, local);
    const registered = await client.chain.invoke(
      testnetEvidence.deployment.contracts.market.contractId,
      "register_bid",
      [nativeToScVal(Uint8Array.from(round.roundId.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)), { type: "bytes" }), new Address(session.address).toScVal()],
      signer,
    );
    await api("/api/sandbox/bids", {
      roundId: round.roundId,
      opening: {
        account: session.address,
        ...local.delegations[round.roundId],
        delegationTransaction: delegated.hash,
        registrationTransaction: registered.hash,
      },
    });
    return { delegationTransaction: delegated.hash, registrationTransaction: registered.hash, ...depositReceipts };
  } finally {
    await prover.destroy();
  }
}

export async function settleSandboxRound(roundId: string) {
  return api<SandboxRound>("/api/sandbox/settle", { roundId });
}

export async function reclaimSandboxBid(session: WalletSession, round: SandboxRound) {
  if (!round.winner) throw new Error("Round is not settled yet");
  if (round.winner === session.address) throw new Error("The winning bid was consumed by settlement");
  const local = loadLocal(session.address);
  const delegation = local?.delegations[round.roundId];
  if (!local || !delegation) throw new Error("This browser does not hold the bid opening");
  await configureBrowserProver();
  const witness = buildRevokeSpenderWitness({
    ownerKeys: deriveKeys(BigInt(local.secret), addressToField(TOKEN)),
    spendableValue: BigInt(local.spendableValue),
    spendableRandomness: BigInt(local.spendableRandomness),
    allowance: BigInt(delegation.value),
    allowanceRandomness: BigInt(delegation.randomness),
    allowanceSalt: BigInt(delegation.sigmaA),
    spenderId: addressToField(round.controller),
    ownerAuditorKey: deploymentAuditorKey(),
  });
  const prover = proverFromArtifact(revokeSpenderArtifact);
  try {
    const generated = await prover.prove(witness.inputs);
    const result = await productClient().chain.invoke(
      TOKEN,
      "revoke_spender",
      [
        new Address(session.address).toScVal(),
        new Address(round.controller).toScVal(),
        encodeRevokeSpenderData(witness, generated.proof),
      ],
      freighterSigner(session),
    );
    local.spendableValue = witness.nextSpendable.value.toString();
    local.spendableRandomness = witness.nextSpendable.randomness.toString();
    delete local.delegations[round.roundId];
    saveLocal(session.address, local);
    return { transaction: result.hash };
  } finally {
    await prover.destroy();
  }
}
