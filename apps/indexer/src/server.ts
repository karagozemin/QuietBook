import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultDatabasePath, evidenceFiles, root } from "./config.js";
import { EvidenceDatabase } from "./db.js";
import { syncEvidenceStore } from "./sync.js";
import { LiveSandbox, type BidOpening } from "./sandbox.js";

const database = new EvidenceDatabase(process.env.QUIETBOOK_INDEXER_DB ?? defaultDatabasePath);
const port = Number(process.env.QUIETBOOK_INDEXER_PORT ?? 8787);
let syncing: Promise<unknown> | null = null;
const sandbox = new LiveSandbox();

function sync() {
  syncing ??= syncEvidenceStore(database).finally(() => {
    syncing = null;
  });
  return syncing;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > 64_000) throw new Error("request_too_large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function evidenceManifest() {
  return Object.fromEntries(
    evidenceFiles.map((file) => [
      file.replace(/\.json$/, ""),
      JSON.parse(readFileSync(join(root, "docs/evidence/testnet", file), "utf8")),
    ]),
  );
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "OPTIONS") return json(response, 204, null);
    if (request.method === "POST" && url.pathname.startsWith("/api/sandbox/")) {
      const input = await body(request);
      if (url.pathname === "/api/sandbox/prepare") {
        const bidWindowLedgers = input.bidWindowLedgers === undefined
          ? undefined
          : Number(input.bidWindowLedgers);
        return json(response, 200, await sandbox.prepareRound(String(input.issuer ?? ""), bidWindowLedgers));
      }
      if (url.pathname === "/api/sandbox/activate") {
        const result = sandbox.activate({
          setupId: String(input.setupId ?? ""),
          roundId: String(input.roundId ?? ""),
          receipts: (input.receipts ?? {}) as Record<string, string>,
        });
        await sync();
        return json(response, 200, result);
      }
      if (url.pathname === "/api/sandbox/allowlist") {
        return json(response, 200, await sandbox.allowlist(String(input.roundId ?? ""), String(input.account ?? "")));
      }
      if (url.pathname === "/api/sandbox/bids") {
        const result = sandbox.recordBid(String(input.roundId ?? ""), input.opening as BidOpening);
        await sync();
        return json(response, 200, result);
      }
      if (url.pathname === "/api/sandbox/settle") {
        const result = await sandbox.settle(String(input.roundId ?? ""));
        await sync();
        return json(response, 200, result);
      }
      return json(response, 404, { error: "not_found" });
    }
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    if (url.pathname === "/health") {
      return json(response, 200, { status: "ok", syncing: Boolean(syncing), ...database.health() });
    }
    if (url.pathname === "/api/rounds") return json(response, 200, { rounds: database.listRounds() });
    if (url.pathname === "/api/sandbox/rounds") return json(response, 200, { rounds: sandbox.list() });
    if (url.pathname === "/api/evidence/latest") {
      return json(response, 200, { network: "testnet", evidence: evidenceManifest() });
    }
    const match = url.pathname.match(/^\/api\/rounds\/([0-9a-f]{64})(?:\/events)?$/);
    if (match) {
      const round = database.round(match[1]!);
      if (!round) return json(response, 404, { error: "round_not_found" });
      if (url.pathname.endsWith("/events")) {
        return json(response, 200, { roundId: match[1], events: database.publicEvents(match[1]!) });
      }
      return json(response, 200, { round, events: database.publicEvents(match[1]!) });
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return json(response, 500, { error: message.slice(0, 240) });
  }
});

await sync();
const interval = setInterval(() => void sync(), 30_000);
server.listen(port, "127.0.0.1", () => {
  console.log(`QuietBook indexer listening on http://127.0.0.1:${port}`);
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
