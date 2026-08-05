import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultDatabasePath, evidenceFiles, root } from "./config.js";
import { EvidenceDatabase } from "./db.js";
import { syncEvidenceStore } from "./sync.js";

const database = new EvidenceDatabase(process.env.QUIETBOOK_INDEXER_DB ?? defaultDatabasePath);
const port = Number(process.env.QUIETBOOK_INDEXER_PORT ?? 8787);
let syncing: Promise<unknown> | null = null;

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
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
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
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    if (url.pathname === "/health") {
      return json(response, 200, { status: "ok", syncing: Boolean(syncing), ...database.health() });
    }
    if (url.pathname === "/api/rounds") return json(response, 200, { rounds: database.listRounds() });
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
  } catch {
    return json(response, 500, { error: "internal_error" });
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
