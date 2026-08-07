import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { SandboxAuth } from "./auth.js";
import {
  allowedOrigins,
  assertProductionConfig,
  authAudience,
  controllerWasmPath,
  deployment,
  defaultDatabasePath,
  evidenceFiles,
  indexerHost,
  indexerPort,
  root,
  sessionSecret,
} from "./config.js";
import { EvidenceDatabase } from "./db.js";
import { RateLimiter } from "./rate-limit.js";
import { LiveSandbox, type BidOpening } from "./sandbox.js";
import { syncEvidenceStore } from "./sync.js";

assertProductionConfig();
if (!Number.isInteger(indexerPort) || indexerPort < 1 || indexerPort > 65_535) {
  throw new Error("QUIETBOOK_INDEXER_PORT must be a valid TCP port");
}

const database = new EvidenceDatabase(process.env.QUIETBOOK_INDEXER_DB ?? defaultDatabasePath);
const sandbox = new LiveSandbox();
const auth = new SandboxAuth(sessionSecret, authAudience);
const requestLimiter = new RateLimiter(300, 60_000);
const authLimiter = new RateLimiter(10, 10 * 60_000);
const mutationLimiter = new RateLimiter(60, 10 * 60_000);
const expensiveLimiter = new RateLimiter(10, 60 * 60_000);
let syncing: Promise<unknown> | null = null;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

function sync() {
  syncing ??= syncEvidenceStore(database).finally(() => {
    syncing = null;
  });
  return syncing;
}

function normalizedOrigin(request: IncomingMessage) {
  return request.headers.origin?.replace(/\/$/, "");
}

function responseHeaders(origin?: string) {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin && allowedOrigins.includes(origin) ? origin : "",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function json(response: ServerResponse, status: number, value: unknown, origin?: string, retryAfter?: number) {
  response.writeHead(status, {
    ...responseHeaders(origin),
    ...(retryAfter ? { "retry-after": String(retryAfter) } : {}),
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > 64_000) throw new HttpError(413, "request_too_large");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function clientIp(request: IncomingMessage) {
  const forwarded = request.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return first?.trim() || request.socket.remoteAddress || "unknown";
}

function consume(limiter: RateLimiter, key: string) {
  const result = limiter.consume(key);
  if (!result.allowed) throw new HttpError(429, "rate_limit_exceeded", result.retryAfter);
}

function actor(request: IncomingMessage) {
  try {
    return auth.authenticate(request.headers.authorization);
  } catch (error) {
    throw new HttpError(401, error instanceof Error ? error.message : "Wallet API session is invalid");
  }
}

function assertActor(expected: string, actual: string) {
  if (expected !== actual) throw new HttpError(403, "Wallet API session does not match this action");
}

function confidentialEventsForWallet(account: string) {
  const result: Array<{ id: string; ledger: number; txHash: string; topic: string[]; value: string }> = [];
  for (const event of database.confidentialEvents(deployment.contracts.confidentialToken.contractId)) {
    try {
      const raw = JSON.parse(event.rawXdr) as { topic?: string[]; value?: string };
      if (!Array.isArray(raw.topic) || typeof raw.value !== "string") continue;
      const topics = raw.topic.map((encoded) => xdr.ScVal.fromXDR(encoded, "base64"));
      const addresses = topics
        .slice(1)
        .map((topic) => {
          try {
            return String(scValToNative(topic));
          } catch {
            return "";
          }
        });
      if (!addresses.includes(account)) continue;
      result.push({ id: event.id, ledger: event.ledger, txHash: event.txHash, topic: raw.topic, value: raw.value });
    } catch {
      // Ignore a corrupt historical row; the RPC fallback can still supply it.
    }
  }
  return result;
}

function evidenceManifest() {
  return Object.fromEntries(
    evidenceFiles.map((file) => [
      file.replace(/\.json$/, ""),
      JSON.parse(readFileSync(join(root, "docs/evidence/testnet", file), "utf8")),
    ]),
  );
}

function errorStatus(error: unknown) {
  if (error instanceof HttpError) return error.status;
  const message = error instanceof Error ? error.message : "";
  if (/Only the|does not match|preparing issuer/i.test(message)) return 403;
  if (/not found|Unknown round preparation/i.test(message)) return 404;
  if (/already recorded|capacity|already/i.test(message)) return 409;
  if (/invalid|must be|missing|closed|open for/i.test(message)) return 400;
  return 500;
}

const server = createServer(async (request, response) => {
  const origin = normalizedOrigin(request);
  try {
    if (origin && !allowedOrigins.includes(origin)) throw new HttpError(403, "origin_not_allowed");
    consume(requestLimiter, clientIp(request));
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "OPTIONS") return json(response, 204, null, origin);

    if (request.method === "POST" && url.pathname === "/api/auth/challenge") {
      consume(authLimiter, `challenge:${clientIp(request)}`);
      const input = await body(request);
      return json(response, 200, auth.challenge(String(input.account ?? "")), origin);
    }
    if (request.method === "POST" && url.pathname === "/api/auth/verify") {
      consume(authLimiter, `verify:${clientIp(request)}`);
      const input = await body(request);
      const result = auth.verifyChallenge(
        String(input.account ?? ""),
        String(input.nonce ?? ""),
        String(input.signature ?? ""),
      );
      return json(response, 200, result, origin);
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/sandbox/")) {
      const wallet = actor(request);
      consume(mutationLimiter, `${wallet}:${clientIp(request)}`);
      const input = await body(request);
      if (url.pathname === "/api/sandbox/prepare") {
        consume(expensiveLimiter, `prepare:${wallet}`);
        assertActor(String(input.issuer ?? ""), wallet);
        const bidWindowLedgers = input.bidWindowLedgers === undefined
          ? undefined
          : Number(input.bidWindowLedgers);
        return json(response, 200, await sandbox.prepareRound(wallet, bidWindowLedgers), origin);
      }
      if (url.pathname === "/api/sandbox/activate") {
        const result = sandbox.activate({
          setupId: String(input.setupId ?? ""),
          roundId: String(input.roundId ?? ""),
          receipts: (input.receipts ?? {}) as Record<string, string>,
        }, wallet);
        await sync();
        return json(response, 200, result, origin);
      }
      if (url.pathname === "/api/sandbox/allowlist") {
        assertActor(String(input.account ?? ""), wallet);
        return json(response, 200, await sandbox.allowlist(String(input.roundId ?? ""), wallet, wallet), origin);
      }
      if (url.pathname === "/api/sandbox/bids") {
        const opening = input.opening as BidOpening;
        assertActor(String(opening?.account ?? ""), wallet);
        const result = sandbox.recordBid(String(input.roundId ?? ""), opening, wallet);
        await sync();
        return json(response, 200, result, origin);
      }
      if (url.pathname === "/api/sandbox/settle") {
        consume(expensiveLimiter, `settle:${wallet}`);
        const result = await sandbox.settle(String(input.roundId ?? ""), wallet);
        await sync();
        return json(response, 200, result, origin);
      }
      throw new HttpError(404, "not_found");
    }

    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    if (url.pathname === "/health") {
      return json(response, 200, { status: "ok", syncing: Boolean(syncing), ...database.health() }, origin);
    }
    if (url.pathname === "/ready") {
      if (!existsSync(controllerWasmPath)) throw new HttpError(503, "controller_wasm_unavailable");
      return json(response, 200, { status: "ready" }, origin);
    }
    if (url.pathname === "/api/rounds") return json(response, 200, { rounds: database.listRounds() }, origin);
    if (url.pathname === "/api/sandbox/rounds") return json(response, 200, { rounds: sandbox.list() }, origin);
    if (url.pathname === "/api/sandbox/confidential-events") {
      const wallet = actor(request);
      const account = url.searchParams.get("account") ?? "";
      assertActor(account, wallet);
      consume(mutationLimiter, `events:${wallet}:${clientIp(request)}`);
      return json(response, 200, { events: confidentialEventsForWallet(wallet) }, origin);
    }
    if (url.pathname === "/api/evidence/latest") {
      return json(response, 200, { network: "testnet", evidence: evidenceManifest() }, origin);
    }
    const match = url.pathname.match(/^\/api\/rounds\/([0-9a-f]{64})(?:\/events)?$/);
    if (match) {
      const round = database.round(match[1]!);
      if (!round) throw new HttpError(404, "round_not_found");
      if (url.pathname.endsWith("/events")) {
        return json(response, 200, { roundId: match[1], events: database.publicEvents(match[1]!) }, origin);
      }
      return json(response, 200, { round, events: database.publicEvents(match[1]!) }, origin);
    }
    throw new HttpError(404, "not_found");
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    const retryAfter = error instanceof HttpError ? error.retryAfter : undefined;
    return json(response, errorStatus(error), { error: message.slice(0, 240) }, origin, retryAfter);
  }
});

await sync();
const interval = setInterval(() => void sync(), 30_000);
server.listen(indexerPort, indexerHost, () => {
  console.log(`QuietBook indexer listening on http://${indexerHost}:${indexerPort}`);
});

function shutdown() {
  clearInterval(interval);
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
