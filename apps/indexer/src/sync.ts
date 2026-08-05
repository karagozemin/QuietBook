import { rpc } from "@stellar/stellar-sdk";
import { contractGroups, rpcUrl, startLedger } from "./config.js";
import { EvidenceDatabase } from "./db.js";
import { normalizeEvent } from "./events.js";

export async function syncEvidenceStore(database: EvidenceDatabase) {
  const server = new rpc.Server(rpcUrl);
  let inserted = 0;
  for (const [source, contractIds] of Object.entries(contractGroups)) {
    const previous = database.syncState(source);
    let cursor = previous?.cursor ?? null;
    let latestLedger = previous?.latestLedger ?? startLedger;
    for (;;) {
      const response = await server.getEvents({
        ...(cursor ? { cursor } : { startLedger }),
        filters: [{ type: "contract", contractIds }],
        limit: 100,
      });
      for (const event of response.events) {
        if (database.insertEvent(normalizeEvent(event))) inserted += 1;
      }
      latestLedger = response.latestLedger;
      const nextCursor = response.cursor || cursor;
      database.setSyncState(source, nextCursor, latestLedger);
      if (response.events.length < 100 || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
  }
  return { inserted, ...database.health() };
}
