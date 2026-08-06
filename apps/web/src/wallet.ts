import {
  getAddress,
  getNetwork,
  isAllowed,
  isConnected,
  requestAccess,
  signMessage,
  signTransaction,
} from "@stellar/freighter-api";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  scValToNative,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  QuietBookClient,
  type ProductChain,
} from "@quietbook/sdk/product";
import { testnetEvidence } from "./evidence";

const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_ATTEMPTS = 40;

export type WalletSession = {
  address: string;
  network: string;
  networkPassphrase: string;
};

export type BrowserSigner = {
  publicKey: string;
  sign(txXdrBase64: string): Promise<string>;
};

function freighterError(error: unknown, fallback: string): Error {
  if (error && typeof error === "object" && "message" in error) {
    return new Error(String(error.message));
  }
  return new Error(fallback);
}

export async function connectFreighter(): Promise<WalletSession> {
  const connection = await isConnected();
  if (connection.error || !connection.isConnected) {
    throw new Error("Freighter extension was not detected");
  }
  const access = await requestAccess();
  if (access.error) throw freighterError(access.error, "Freighter access was denied");
  if (!access.address) throw new Error("Freighter did not return an account");

  const network = await getNetwork();
  if (network.error) throw freighterError(network.error, "Could not read Freighter network");
  if (network.networkPassphrase !== Networks.TESTNET) {
    throw new Error("Switch Freighter to Stellar Testnet to enable QuietBook actions");
  }
  return {
    address: access.address,
    network: network.network,
    networkPassphrase: network.networkPassphrase,
  };
}

export async function restoreFreighter(): Promise<WalletSession | null> {
  const connection = await isConnected();
  if (connection.error || !connection.isConnected) return null;
  const permission = await isAllowed();
  if (permission.error || !permission.isAllowed) return null;
  const [account, network] = await Promise.all([getAddress(), getNetwork()]);
  if (account.error || network.error || !account.address) return null;
  if (network.networkPassphrase !== Networks.TESTNET) return null;
  return {
    address: account.address,
    network: network.network,
    networkPassphrase: network.networkPassphrase,
  };
}

export function freighterSigner(session: WalletSession): BrowserSigner {
  return {
    publicKey: session.address,
    async sign(txXdrBase64: string) {
      const current = await getNetwork();
      if (current.error) throw freighterError(current.error, "Could not verify Freighter network");
      if (current.networkPassphrase !== Networks.TESTNET) {
        throw new Error("Freighter network changed; switch back to Stellar Testnet");
      }
      const signed = await signTransaction(txXdrBase64, {
        address: session.address,
        networkPassphrase: Networks.TESTNET,
      });
      if (signed.error) throw freighterError(signed.error, "Freighter rejected the transaction");
      if (!signed.signedTxXdr) throw new Error("Freighter returned no signed transaction");
      return signed.signedTxXdr;
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Freighter's signMessage return type varies across versions and across the
 * extension messaging boundary. It can arrive as a base64 string, a Buffer, a
 * Uint8Array, a serialized `{ type: "Buffer", data: [...] }` object, a plain
 * number array, or a Uint8Array serialized to `{ "0": .., "1": .. }`. Normalize
 * all of these into a clean base64 string so the backend can verify the 64-byte
 * ed25519 signature reliably.
 */
function normalizeSignedMessage(value: unknown): string {
  if (typeof value === "string") return value; // already base64/base64url
  if (value instanceof Uint8Array) return bytesToBase64(value);
  if (Array.isArray(value)) return bytesToBase64(Uint8Array.from(value as number[]));
  if (value && typeof value === "object") {
    const record = value as { type?: string; data?: number[]; [key: string]: unknown };
    if (record.type === "Buffer" && Array.isArray(record.data)) {
      return bytesToBase64(Uint8Array.from(record.data));
    }
    // Uint8Array serialized to an index-keyed object: { "0": 12, "1": 34, ... }
    const keys = Object.keys(record).filter((key) => /^\d+$/.test(key));
    if (keys.length > 0) {
      const bytes = new Uint8Array(keys.length);
      for (const key of keys) bytes[Number(key)] = Number(record[key]);
      return bytesToBase64(bytes);
    }
  }
  throw new Error("Freighter returned an unrecognized sandbox authorization signature");
}

export async function authorizeSandboxMessage(session: WalletSession, message: string) {
  const signed = await signMessage(message, {
    address: session.address,
    networkPassphrase: Networks.TESTNET,
  });
  if (signed.error) throw freighterError(signed.error, "Freighter rejected sandbox authorization");
  if (!signed.signedMessage) throw new Error("Freighter returned no sandbox authorization signature");
  if (signed.signerAddress && signed.signerAddress !== session.address) {
    throw new Error("Freighter authorized the sandbox with a different account");
  }
  return normalizeSignedMessage(signed.signedMessage);
}


export class BrowserProductChain implements ProductChain {
  readonly server: rpc.Server;

  constructor(readonly rpcUrl: string) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  async simulate(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const source = await this.server.getAccount(NULL_ACCOUNT).catch(() => new Account(NULL_ACCOUNT, "0"));
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`simulate ${method} failed: ${simulation.error}`);
    }
    if (!simulation.result) throw new Error(`simulate ${method} returned no result`);
    return simulation.result.retval;
  }

  async invoke(contractId: string, method: string, args: xdr.ScVal[], signer: BrowserSigner) {
    const source = await this.server.getAccount(signer.publicKey);
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(180)
      .build();
    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`simulate ${method} failed: ${simulation.error}`);
    }
    const assembled = rpc.assembleTransaction(transaction, simulation).build();
    const signedXdr = await signer.sign(assembled.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    const submitted = await this.server.sendTransaction(signed);
    if (submitted.status === "ERROR") throw new Error(`${method} was rejected by Testnet`);

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
      const result = await this.server.getTransaction(submitted.hash);
      if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`${method} failed on Testnet (${submitted.hash})`);
      }
      return { hash: submitted.hash, status: result.status, returnValue: result.returnValue };
    }
    throw new Error(`${method} confirmation timed out (${submitted.hash})`);
  }
}

export function productClient(market = testnetEvidence.deployment.contracts.market.contractId) {
  return new QuietBookClient(
    new BrowserProductChain(testnetEvidence.deployment.rpcUrl),
    {
      market,
      confidentialToken: testnetEvidence.deployment.contracts.confidentialToken.contractId,
    },
  );
}

export async function latestTestnetLedger() {
  const server = new rpc.Server(testnetEvidence.deployment.rpcUrl);
  return (await server.getLatestLedger()).sequence;
}

export async function checkPolicyEligibility(account: string): Promise<boolean> {
  const client = productClient();
  const result = await client.chain.simulate(
    testnetEvidence.deployment.contracts.eligibilityPolicy.contractId,
    "is_authorized",
    [
      new Address(account).toScVal(),
      new Address(testnetEvidence.deployment.contracts.confidentialToken.contractId).toScVal(),
    ],
  );
  return scValToNative(result) === true;
}

export async function closeLifecycleRound(session: WalletSession) {
  const client = new QuietBookClient(
    new BrowserProductChain(testnetEvidence.deployment.rpcUrl),
    {
      market: testnetEvidence.withdrawal.market,
      confidentialToken: testnetEvidence.deployment.contracts.confidentialToken.contractId,
    },
  );
  return client.closeRound(testnetEvidence.withdrawal.roundId, freighterSigner(session));
}
