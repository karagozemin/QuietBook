import { Address, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import initAcvm from "@noir-lang/acvm_js";
import acvmWasmUrl from "@noir-lang/acvm_js/web/acvm_js_bg.wasm?url";
import initNoircAbi from "@noir-lang/noirc_abi";
import noircAbiWasmUrl from "@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm?url";
import {
  addressToField,
  commit,
  cursorLedger,
  deriveKeys,
  deriveSpendR,
  DOMAIN,
  fpAdd,
  frMod,
  fromBytesBE,
  poseidonWithDomain,
  pointToBytes,
  pointFromBytes,
  proverFromArtifact,
  setUltraHonkBackendLoader,
} from "@ctd/sdk";

import {
  buildAccountBoundRegisterWitness,
  buildRevokeSpenderWitness,
  buildSetSpenderWitness,
  decryptIncomingTransfer,
  encodeRegisterData,
  encodeRevokeSpenderData,
  parseConfidentialAccount,
} from "@quietbook/sdk";
import registerArtifact from "../../../packages/sdk/circuits/register.json";
import setSpenderArtifact from "../../../packages/sdk/circuits/set_spender.json";
import revokeSpenderArtifact from "../../../packages/sdk/circuits/revoke_spender.json";
import { testnetEvidence } from "./evidence";
import { authorizeSandboxMessage, deriveConfidentialSeedSignature, freighterSigner, latestTestnetLedger, productClient, type WalletSession } from "./wallet";

const API = (import.meta.env.VITE_INDEXER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DEPOSIT = 200_000_000n;
const MIN_BID = 80_000_000n;
const LEDGERS_PER_MINUTE = 12;
const TOKEN = testnetEvidence.deployment.contracts.confidentialToken.contractId;
const LIVE_MARKET = testnetEvidence.deployment.liveMarket.contractId;

type LocalDelegation = {
  value: string;
  randomness: string;
  dvk: string;
  sigmaA: string;
  nextSpendableValue?: string;
  nextSpendableRandomness?: string;
  transaction?: string;
};
type LocalConfidentialState = {
  secret: string;
  spendableValue: string;
  spendableRandomness: string;
  delegations: Record<string, LocalDelegation>;
};
export type SandboxRound = {
  roundId: string;
  market: string;
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

export type CreateRoundStage = "account" | "controller" | "approval" | "confirmation" | "activation";
type CreateRoundProgress = (stage: CreateRoundStage) => void;
export type BidStage = "validation" | "account" | "access" | "balance" | "proof" | "transaction" | "approval" | "confirmation" | "evidence";
type BidProgress = (stage: BidStage) => void;

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

type SandboxApiSession = { token: string; account: string; expiresAt: string };

function apiSessionKey(account: string) {
  return `quietbook:sandbox-api:${API}:${account}`;
}

async function request<T>(path: string, input?: unknown, token?: string) {
  const response = await fetch(`${API}${path}`, input === undefined ? undefined : {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  });
  const result = await response.json() as T & { error?: string };
  return { response, result };
}

async function sandboxApiToken(session: WalletSession, force = false) {
  const key = apiSessionKey(session.address);
  if (!force) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(key) ?? "null") as SandboxApiSession | null;
      if (cached?.account === session.address && Date.parse(cached.expiresAt) > Date.now() + 30_000) {
        return cached.token;
      }
    } catch {
      sessionStorage.removeItem(key);
    }
  }
  const challengeResult = await request<{ nonce: string; message: string; expiresAt: string }>(
    "/api/auth/challenge",
    { account: session.address },
  );
  if (!challengeResult.response.ok) {
    throw new Error(challengeResult.result.error ?? "Could not start wallet API authorization");
  }
  const signature = await authorizeSandboxMessage(session, challengeResult.result.message);
  const verification = await request<SandboxApiSession>("/api/auth/verify", {
    account: session.address,
    nonce: challengeResult.result.nonce,
    signature,
  });
  if (!verification.response.ok) {
    throw new Error(verification.result.error ?? "Wallet API authorization failed");
  }
  sessionStorage.setItem(key, JSON.stringify(verification.result));
  return verification.result.token;
}

async function api<T>(path: string, input?: unknown, session?: WalletSession, retried = false): Promise<T> {
  const token = session ? await sandboxApiToken(session, retried) : undefined;
  const { response, result } = await request<T>(path, input, token);
  if (response.status === 401 && session && !retried) {
    sessionStorage.removeItem(apiSessionKey(session.address));
    return api<T>(path, input, session, true);
  }
  if (!response.ok) throw new Error(result.error ?? `Sandbox request failed (${response.status})`);
  return result;
}

async function apiGet<T>(path: string, session: WalletSession, retried = false): Promise<T> {
  const token = await sandboxApiToken(session, retried);
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const result = await response.json() as T & { error?: string };
  if (response.status === 401 && !retried) {
    sessionStorage.removeItem(apiSessionKey(session.address));
    return apiGet<T>(path, session, true);
  }
  if (!response.ok) throw new Error(result.error ?? `Sandbox request failed (${response.status})`);
  return result;
}

export async function listSandboxRounds(): Promise<SandboxRound[]> {
  return (await api<{ rounds: SandboxRound[] }>("/api/sandbox/rounds")).rounds;
}

export function hasSandboxDelegation(account: string, roundId: string) {
  return Boolean(loadLocal(account)?.delegations[roundId]);
}

/**
 * Deterministically derive the wallet's confidential spending secret from a
 * fixed, wallet-signed message. ed25519 signatures are deterministic (RFC 8032),
 * so the same account always yields the same scalar — in any browser, on any
 * device. `frMod` reduces the 64-byte signature into the scalar field exactly
 * like {@link randomScalar}'s accepted range, and a zero result (astronomically
 * unlikely) is nudged to 1 to stay in `[1, r)`.
 */
async function deriveConfidentialSecret(session: WalletSession): Promise<bigint> {
  const signature = await deriveConfidentialSeedSignature(session);
  const scalar = frMod(fromBytesBE(signature));
  return scalar === 0n ? 1n : scalar;
}

/**
 * Rebuild this browser's local confidential state for an already-registered
 * account. The secret is re-derived from the wallet signature; the spendable
 * and receiving openings are then recovered from retained Testnet events by the
 * bid flow's reconciliation logic, so a zeroed opening is a safe starting point.
 */
async function recoverLocalState(session: WalletSession): Promise<LocalConfidentialState> {
  const secret = await deriveConfidentialSecret(session);
  const state: LocalConfidentialState = {
    secret: `0x${secret.toString(16).padStart(64, "0")}`,
    spendableValue: "0",
    spendableRandomness: "0",
    delegations: {},
  };
  saveLocal(session.address, state);
  return state;
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
    // The account exists on-chain but this browser has no local key material.
    // Re-derive it deterministically from the wallet so the same account can
    // rejoin its rounds from a second browser without ever exporting a key.
    if (!existing && requireLocalState) {
      await recoverLocalState(session);
    }
    return { transaction: "", created: false };
  }

  await configureBrowserProver();
  const secret = await deriveConfidentialSecret(session);
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

export async function createSandboxRound(
  session: WalletSession,
  bidWindowMinutes: number,
  onProgress?: CreateRoundProgress,
) {
  onProgress?.("account");
  await initializeConfidentialAccount(session, false);
  onProgress?.("controller");
  const prepared = await api<PreparedRound>("/api/sandbox/prepare", {
    issuer: session.address,
    bidWindowLedgers: bidWindowMinutes * LEDGERS_PER_MINUTE,
  }, session);
  const client = productClient(LIVE_MARKET);
  const walletSigner = freighterSigner(session);
  const signer = {
    publicKey: walletSigner.publicKey,
    async sign(txXdrBase64: string) {
      onProgress?.("approval");
      const signed = await walletSigner.sign(txXdrBase64);
      onProgress?.("confirmation");
      return signed;
    },
  };
  const opened = await client.createAndOpenRound(
    {
      ...prepared.config,
      rwaLot: BigInt(prepared.config.rwaLot),
      reservePublic: BigInt(prepared.config.reservePublic),
    },
    prepared.config.auditorId,
    xdr.ScVal.fromXDR(prepared.registerDataXdr, "base64"),
    signer,
  );
  onProgress?.("activation");
  return api<SandboxRound>("/api/sandbox/activate", {
    setupId: prepared.setupId,
    roundId: opened.roundId,
    receipts: {
      createAndOpenRound: opened.transaction,
    },
  }, session);
}

function bidWindowClosed(): Error {
  return new Error("This bid window has closed. No bid transaction was submitted. Open the next issuance to continue.");
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function opensCommitment(commitment: Uint8Array, value: bigint, randomness: bigint) {
  return bytesEqual(pointToBytes(commit(value, randomness)), commitment);
}

/**
 * Decrypt an incoming transfer/spender_transfer, tolerating events that target
 * this account by address but do not decrypt for the holder's *current* keys.
 *
 * {@link decryptIncomingTransfer} throws when the recovered amount is out of
 * range, which legitimately happens when replaying history that spans a
 * confidential key/seed epoch (a re-derived client sees older ciphertexts it
 * can no longer open). During event replay that throw would abort the whole
 * loop before reaching the {@link opensCommitment} guard, stranding sync/live
 * bid recovery. Returning `null` here lets the caller skip the event; the final
 * commitment check still rejects any incorrect reconstruction, so this only
 * widens what we can recover — never what we accept.
 */
function tryDecryptIncoming(
  params: Parameters<typeof decryptIncomingTransfer>[0],
): ReturnType<typeof decryptIncomingTransfer> | null {
  try {
    return decryptIncomingTransfer(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("does not decrypt")) return null;
    throw error;
  }
}


/** Recover public deposits left behind by an older interrupted, non-atomic flow. */
function reconcilePublicDeposits(commitment: Uint8Array, value: bigint, randomness: bigint) {
  for (let deposits = 0n; deposits <= 10n; deposits += 1n) {
    const candidate = value + (deposits * DEPOSIT);
    if (opensCommitment(commitment, candidate, randomness)) return candidate;
  }
  return null;
}

function topicAddress(event: rpc.Api.EventResponse, index: number) {
  const topic = event.topic[index];
  return topic ? String(scValToNative(topic)) : "";
}

function eventFields(event: rpc.Api.EventResponse) {
  return new Map((event.value.map() ?? []).map((entry) => [entry.key().sym().toString(), entry.val()]));
}

function requiredEventField(fields: Map<string, xdr.ScVal>, ...names: string[]) {
  for (const name of names) {
    const value = fields.get(name);
    if (value) return value;
  }
  throw new Error(`Confidential event is missing ${names.join(" or ")}`);
}

async function recoverReceivingOpening(
  session: WalletSession,
  holderKeys: ReturnType<typeof deriveKeys>,
  expectedCommitment: Uint8Array,
) {
  const account = session.address;
  let value = 0n;
  let randomness = 0n;

  for (const event of await historicalTokenEvents(session)) {
      const name = event.topic[0]?.sym().toString();
      if (name === "merge" && topicAddress(event, 1) === account) {
        value = 0n;
        randomness = 0n;
        continue;
      }
      if (name === "deposit" && topicAddress(event, 2) === account) {
        value += BigInt(scValToNative(requiredEventField(eventFields(event), "amount")));
        continue;
      }
      const isTransfer = name === "transfer" && topicAddress(event, 2) === account;
      const isSpenderTransfer = name === "spender_transfer" && topicAddress(event, 3) === account;
      if (!isTransfer && !isSpenderTransfer) continue;
      const fields = eventFields(event);
      const opening = tryDecryptIncoming({
        holderKeys,
        rE: pointFromBytes(new Uint8Array(requiredEventField(fields, "r_e", "r_e_point").bytes())),
        sigma: fromBytesBE(new Uint8Array(requiredEventField(fields, "sigma", "sigma_a").bytes())),
        vTilde: fromBytesBE(new Uint8Array(requiredEventField(fields, "v_tilde").bytes())),
      });
      // An event that targets this account by address but predates the current
      // confidential key epoch cannot be opened; skip it rather than aborting.
      if (!opening) continue;
      value += opening.value;
      randomness = fpAdd(randomness, opening.randomness);
  }

  return opensCommitment(expectedCommitment, value, randomness)
    ? { value, randomness }
    : null;
}

/**
 * Reconstruct this account's spendable opening from retained Testnet events.
 *
 * A second browser rebuilds its local state with a zeroed spendable opening
 * (see {@link recoverLocalState}). Whenever the account has spent, delegated,
 * or merged, the on-chain spendable commitment carries a value/randomness that
 * {@link reconcilePublicDeposits} cannot reproduce, so we replay the account's
 * public event history instead.
 *
 * The replay mirrors the canonical `StateEngine.apply` reconstruction rules
 * exactly, so every account — including one that has already spent — recovers
 * the same opening the engine would:
 *   - deposit(_, me)      → credit a pending receiving opening (r = 0).
 *   - transfer(other, me) → ECDH-decrypt (v_tx, r_tx); credit receiving.
 *   - merge(me)               → fold the pending receiving opening into spendable.
 *   - withdraw(me, _)         → SET spendable = open(b_tilde, sigma).
 *   - transfer(me, _)         → SET spendable = open(b_tilde, sigma).
 *   - set_spender(me, _)      → SET spendable = open(b_tilde, sigma).
 *   - revoke_spender(me, _)   → SET spendable = open(b_tilde, sigma).
 *
 * The four SET rules are the correction over the previous credit-only replay:
 * `withdraw`, outgoing `transfer`, and both delegation ops (`set_spender` /
 * `revoke_spender`) overwrite the spendable opening rather than add to it, so an
 * account that had already spent or delegated (i.e. placed a bid) used to be
 * irrecoverable. `open(b_tilde, sigma)` reads the resulting spendable value
 * straight from the event, matching {@link StateEngine.openSpendable}.
 *
 * The result is only returned when it actually opens the supplied commitment,

 * so a partial or divergent history can never yield an incorrect opening — it
 * degrades safely to `null`.
 */
async function recoverSpendableOpening(
  session: WalletSession,
  holderKeys: ReturnType<typeof deriveKeys>,
  expectedCommitment: Uint8Array,
) {
  const account = session.address;
  let spendableValue = 0n;
  let spendableRandomness = 0n;
  let pendingValue = 0n;
  let pendingRandomness = 0n;

  // Recover the owner's post-op spendable opening from an event's emitted
  // b_tilde, identical to StateEngine.openSpendable:
  //   v = b_tilde - Poseidon2(ENC_BAL, [vk, sigma]);  r = deriveSpendR(vk, sigma).
  const openSpendable = (bTilde: bigint, sigma: bigint) => ({
    value: frMod(bTilde - poseidonWithDomain(DOMAIN.ENCRYPTED_BALANCE, [holderKeys.vk, sigma])),
    randomness: deriveSpendR(holderKeys.vk, sigma),
  });

  for (const event of await historicalTokenEvents(session)) {
      const name = event.topic[0]?.sym().toString();
      // merge(me): fold the pending receiving opening into spendable.
      if (name === "merge" && topicAddress(event, 1) === account) {
        spendableValue += pendingValue;
        spendableRandomness = fpAdd(spendableRandomness, pendingRandomness);
        pendingValue = 0n;
        pendingRandomness = 0n;
        continue;
      }
      // deposit(_, me): credit receiving (deposits carry r = 0).
      if (name === "deposit" && topicAddress(event, 2) === account) {
        pendingValue += BigInt(scValToNative(requiredEventField(eventFields(event), "amount")));
        continue;
      }
      // withdraw(me, _): SET spendable from the event's b_tilde.
      if (name === "withdraw" && topicAddress(event, 1) === account) {
        const fields = eventFields(event);
        const opened = openSpendable(
          fromBytesBE(new Uint8Array(requiredEventField(fields, "b_tilde").bytes())),
          fromBytesBE(new Uint8Array(requiredEventField(fields, "sigma", "sigma_a").bytes())),
        );
        spendableValue = opened.value;
        spendableRandomness = opened.randomness;
        continue;
      }
      // set_spender(me, _) / revoke_spender(me, _): the contract overwrites the
      // owner's spendable_commitment with c_spend_new, and both events emit the
      // owner-facing checkpoint (b_tilde, sigma). SET spendable exactly like
      // withdraw — without this a bid (set_spender) leaves a fresh client unable
      // to reproduce the on-chain commitment, so recovery falls back to null.
      if ((name === "set_spender" || name === "revoke_spender") && topicAddress(event, 1) === account) {
        const fields = eventFields(event);
        const opened = openSpendable(
          fromBytesBE(new Uint8Array(requiredEventField(fields, "b_tilde").bytes())),
          fromBytesBE(new Uint8Array(requiredEventField(fields, "sigma", "sigma_a").bytes())),
        );
        spendableValue = opened.value;
        spendableRandomness = opened.randomness;
        continue;
      }

      // transfer(me, _): SET spendable from the event's b_tilde. A self-transfer
      // (to == me too) also credits receiving below, matching the engine's order.
      if (name === "transfer" && topicAddress(event, 1) === account) {
        const fields = eventFields(event);
        const opened = openSpendable(
          fromBytesBE(new Uint8Array(requiredEventField(fields, "b_tilde").bytes())),
          fromBytesBE(new Uint8Array(requiredEventField(fields, "sigma", "sigma_a").bytes())),
        );
        spendableValue = opened.value;
        spendableRandomness = opened.randomness;
      }
      // transfer(other, me) / spender_transfer(..., me): credit receiving.
      const isTransfer = name === "transfer" && topicAddress(event, 2) === account;
      const isSpenderTransfer = name === "spender_transfer" && topicAddress(event, 3) === account;
      if (!isTransfer && !isSpenderTransfer) continue;
      const fields = eventFields(event);
      const opening = tryDecryptIncoming({
        holderKeys,
        rE: pointFromBytes(new Uint8Array(requiredEventField(fields, "r_e", "r_e_point").bytes())),
        sigma: fromBytesBE(new Uint8Array(requiredEventField(fields, "sigma", "sigma_a").bytes())),
        vTilde: fromBytesBE(new Uint8Array(requiredEventField(fields, "v_tilde").bytes())),
      });
      // Skip an incoming event this key epoch can no longer open rather than
      // aborting the replay; the final commitment check still guards the result.
      if (!opening) continue;
      pendingValue += opening.value;
      pendingRandomness = fpAdd(pendingRandomness, opening.randomness);
  }

  return opensCommitment(expectedCommitment, spendableValue, spendableRandomness)
    ? { value: spendableValue, randomness: spendableRandomness }
    : null;
}

type StoredConfidentialEvent = {
  id: string;
  ledger: number;
  txHash: string;
  topic: string[];
  value: string;
};

/**
 * Merge the durable DigitalOcean event archive with the RPC's newest window.
 * Horizon/Soroban RPC retention is finite; the indexer is the source of truth
 * for older confidential ciphertexts, while RPC fills the few seconds before
 * the next indexer sync. Events are de-duplicated by their stable event id.
 */
async function historicalTokenEvents(session: WalletSession): Promise<rpc.Api.EventResponse[]> {
  const events = new Map<string, rpc.Api.EventResponse>();
  try {
    const archived = await apiGet<{ events: StoredConfidentialEvent[] }>(
      `/api/sandbox/confidential-events?account=${encodeURIComponent(session.address)}`,
      session,
    );
    for (const event of archived.events ?? []) {
      events.set(event.id, {
        id: event.id,
        ledger: event.ledger,
        txHash: event.txHash,
        contractId: TOKEN,
        topic: event.topic.map((encoded) => xdr.ScVal.fromXDR(encoded, "base64")),
        value: xdr.ScVal.fromXDR(event.value, "base64"),
      } as unknown as rpc.Api.EventResponse);
    }
  } catch {
    // A temporarily unavailable indexer must not prevent the direct RPC path.
  }

  const server = new rpc.Server(testnetEvidence.deployment.rpcUrl);
  const health = await server.getHealth();
  let cursor: string | undefined;
  for (;;) {
    const filters = [{ type: "contract" as const, contractIds: [TOKEN] }];
    const response = await server.getEvents(cursor
      ? { filters, cursor, limit: 100 }
      : { filters, startLedger: Math.max(testnetEvidence.deployment.ledgerRange.start, health.oldestLedger), limit: 100 });
    for (const event of response.events) events.set(event.id, event);
    const previous = cursor;
    cursor = response.cursor;
    if (!cursor || cursor === previous || cursorLedger(cursor) >= response.latestLedger) break;
  }
  return [...events.values()].sort((left, right) => left.ledger - right.ledger || left.id.localeCompare(right.id));
}


function plainBidError(error: unknown): Error {

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("#4004")) return bidWindowClosed();
  if (message.includes("#4006")) return new Error("This wallet could not pass the round allowlist. Retry the access check.");
  if (message.includes("#4009")) return new Error("This wallet's bid is already registered on Testnet. Refresh the live round.");
  if (message.includes("#4014")) return new Error("This round already has three bids. No wallet transaction was submitted.");
  if (message.includes("#3503")) return new Error("This wallet already has an active confidential delegation. Retry to resume it instead of creating another one.");
  if (message.includes("#3506")) return new Error("The private balance proof did not match the wallet's current Testnet state. No transaction was submitted.");
  if (/insufficient balance|underfunded/i.test(message)) return new Error("This Testnet wallet needs enough XLM for the 20 XLM confidential deposit and network fee.");
  return error instanceof Error ? error : new Error("The bid could not be prepared before wallet approval");
}

function bidOpening(delegation: LocalDelegation) {
  return {
    value: delegation.value,
    randomness: delegation.randomness,
    dvk: delegation.dvk,
    sigmaA: delegation.sigmaA,
  };
}

export async function submitSandboxBid(
  session: WalletSession,
  round: SandboxRound,
  bid: bigint,
  onProgress?: BidProgress,
) {
  if (bid < MIN_BID || bid > DEPOSIT) throw new Error("Bid must be between 8 and 20 XLM");
  onProgress?.("validation");
  if (await latestTestnetLedger() > round.bidDeadlineLedger) throw bidWindowClosed();
  onProgress?.("account");
  await initializeConfidentialAccount(session);
  const local = loadLocal(session.address);
  if (!local) throw new Error("Confidential state is unavailable in this browser");
  onProgress?.("access");
  await api<{ transaction: string }>("/api/sandbox/allowlist", { roundId: round.roundId, account: session.address }, session);

  const client = productClient(round.market);
  onProgress?.("balance");
  const activeDelegation = scValToNative(await client.chain.simulate(TOKEN, "is_spender", [
    new Address(session.address).toScVal(),
    new Address(round.controller).toScVal(),
  ])) === true;
  const savedDelegation = local.delegations[round.roundId];
  if (activeDelegation) {
    if (!savedDelegation) {
      throw new Error("An active delegation exists for this round, but its private opening is not available in this browser.");
    }
    if (savedDelegation.nextSpendableValue && savedDelegation.nextSpendableRandomness) {
      local.spendableValue = savedDelegation.nextSpendableValue;
      local.spendableRandomness = savedDelegation.nextSpendableRandomness;
      saveLocal(session.address, local);
    }
    const roundBytes = nativeToScVal(Uint8Array.from(
      round.roundId.match(/.{2}/g) ?? [],
      (byte) => Number.parseInt(byte, 16),
    ), { type: "bytes" });
    const chainBidders = scValToNative(await client.chain.simulate(round.market, "get_bidders", [roundBytes])) as string[];
    let transaction = savedDelegation.transaction ?? "";
    if (!chainBidders.includes(session.address)) {
      onProgress?.("transaction");
      const walletSigner = freighterSigner(session);
      const signer = {
        publicKey: walletSigner.publicKey,
        async sign(txXdrBase64: string) {
          onProgress?.("approval");
          const signed = await walletSigner.sign(txXdrBase64);
          onProgress?.("confirmation");
          return signed;
        },
      };
      transaction = (await client.chain.invoke(
        round.market,
        "register_bid",
        [roundBytes, new Address(session.address).toScVal()],
        signer,
      )).hash;
      savedDelegation.transaction = transaction;
      saveLocal(session.address, local);
    }
    onProgress?.("evidence");
    await api("/api/sandbox/bids", {
      roundId: round.roundId,
      opening: {
        account: session.address,
        ...bidOpening(savedDelegation),
        delegationTransaction: transaction,
        registrationTransaction: transaction,
      },
    }, session);
    return { bidTransaction: transaction, registrationTransaction: transaction };
  }
  if (savedDelegation) {
    delete local.delegations[round.roundId];
    saveLocal(session.address, local);
  }

  const bidderValue = await client.chain.simulate(TOKEN, "confidential_balance", [new Address(session.address).toScVal()]);
  const bidderAccount = parseConfidentialAccount(bidderValue);
  let spendableValue = BigInt(local.spendableValue);
  let spendableRandomness = BigInt(local.spendableRandomness);
  const reconciledSpendable = reconcilePublicDeposits(
    bidderAccount.spendableCommitment,
    spendableValue,
    spendableRandomness,
  );
  if (reconciledSpendable === null) {
    // The local opening no longer matches the on-chain spendable commitment —
    // typically a second browser whose zeroed state predates an earlier merge
    // or delegation. Rebuild the full opening (value + randomness) from the
    // account's retained Testnet events before giving up.
    const recovered = await recoverSpendableOpening(
      session,
      deriveKeys(BigInt(local.secret), addressToField(TOKEN)),
      bidderAccount.spendableCommitment,
    );
    if (!recovered) {
      throw new Error("This wallet's private balance changed during an earlier attempt and cannot be opened by this browser. Use a fresh Testnet wallet for this round.");
    }
    spendableValue = recovered.value;
    spendableRandomness = recovered.randomness;
    local.spendableValue = spendableValue.toString();
    local.spendableRandomness = spendableRandomness.toString();
    saveLocal(session.address, local);
  } else if (reconciledSpendable !== spendableValue) {
    spendableValue = reconciledSpendable;
    local.spendableValue = spendableValue.toString();
    saveLocal(session.address, local);
  }

  let receivingValue = reconcilePublicDeposits(bidderAccount.receivingCommitment, 0n, 0n);
  let receivingRandomness = 0n;
  if (receivingValue === null) {
    const recovered = await recoverReceivingOpening(
      session,
      deriveKeys(BigInt(local.secret), addressToField(TOKEN)),
      bidderAccount.receivingCommitment,
    );
    if (!recovered) {
      throw new Error("This wallet's confidential incoming balance could not be recovered from retained Testnet events.");
    }
    receivingValue = recovered.value;
    receivingRandomness = recovered.randomness;
  }

  // A one-stroop deposit forces merge when an older interrupted flow left funds receiving-only.
  const currentTotal = spendableValue + receivingValue;
  const depositAmount = currentTotal < DEPOSIT ? DEPOSIT - currentTotal : receivingValue > 0n ? 1n : 0n;
  spendableValue = currentTotal + depositAmount;
  spendableRandomness = fpAdd(spendableRandomness, receivingRandomness);

  onProgress?.("proof");
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
    if (await latestTestnetLedger() > round.bidDeadlineLedger) throw bidWindowClosed();
    const walletSigner = freighterSigner(session);
    const signer = {
      publicKey: walletSigner.publicKey,
      async sign(txXdrBase64: string) {
        onProgress?.("approval");
        const signed = await walletSigner.sign(txXdrBase64);
        onProgress?.("confirmation");
        return signed;
      },
    };
    const pendingDelegation: LocalDelegation = {
      value: witness.delegation.value.toString(),
      randomness: witness.delegation.randomness.toString(),
      dvk: witness.delegation.dvk.toString(),
      sigmaA: witness.delegation.sigmaA.toString(),
      nextSpendableValue: witness.nextSpendable.value.toString(),
      nextSpendableRandomness: witness.nextSpendable.randomness.toString(),
    };
    local.delegations[round.roundId] = pendingDelegation;
    saveLocal(session.address, local);
    let submitted;
    try {
      onProgress?.("transaction");
      submitted = await client.submitAtomicBid({
        roundId: round.roundId,
        bidder: session.address,
        controller: round.controller,
        settlementDeadlineLedger: round.settlementDeadlineLedger,
        depositAmount,
        witness,
        proof: generated.proof,
      }, signer);
    } catch (error) {
      throw plainBidError(error);
    }
    local.spendableValue = witness.nextSpendable.value.toString();
    local.spendableRandomness = witness.nextSpendable.randomness.toString();
    pendingDelegation.transaction = submitted.hash;
    saveLocal(session.address, local);
    onProgress?.("evidence");
    await api("/api/sandbox/bids", {
      roundId: round.roundId,
      opening: {
        account: session.address,
        ...bidOpening(pendingDelegation),
        delegationTransaction: submitted.hash,
        registrationTransaction: submitted.hash,
      },
    }, session);
    return { bidTransaction: submitted.hash, registrationTransaction: submitted.hash };
  } finally {
    await prover.destroy();
  }
}

export async function settleSandboxRound(session: WalletSession, roundId: string) {
  return api<SandboxRound>("/api/sandbox/settle", { roundId }, session);
}

export async function reclaimSandboxBid(session: WalletSession, round: SandboxRound) {
  if (round.winner === session.address) throw new Error("The winning bid was consumed by settlement");
  if (!round.winner && await latestTestnetLedger() <= round.bidDeadlineLedger) {
    throw new Error("The bid is still active and cannot be reclaimed yet");
  }
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
    const result = await productClient(round.market).chain.invoke(
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
