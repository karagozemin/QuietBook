import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceDatabase, type IndexedEvent } from "../src/db.js";

const base = (event: Partial<IndexedEvent>): IndexedEvent => ({
  id: event.id ?? "1-0",
  contractId: event.contractId ?? "C-MARKET",
  ledger: event.ledger ?? 100,
  txHash: event.txHash ?? "a".repeat(64),
  eventType: event.eventType ?? "round_created",
  roundId: "roundId" in event ? event.roundId! : "b".repeat(64),
  actor: "actor" in event ? event.actor! : "G-ISSUER",
  data: "data" in event ? event.data! : { config: { reserve_public: "80" } },
  rawXdr: event.rawXdr ?? "{}",
});

test("materializes public round state without exposing raw XDR", () => {
  const database = new EvidenceDatabase(":memory:");
  try {
    assert.equal(database.insertEvent(base({})), true);
    assert.equal(database.insertEvent(base({})), false);
    database.insertEvent(base({ id: "2-0", eventType: "round_opened", ledger: 101, data: {} }));
    database.insertEvent(base({ id: "3-0", eventType: "bid_registered", ledger: 102, actor: "G-BIDDER", data: {} }));
    database.insertEvent(base({ id: "4-0", eventType: "bid_withdrawn", ledger: 103, actor: "G-BIDDER", data: {} }));
    const round = database.round("b".repeat(64));
    assert.equal(round?.status, "Open");
    assert.equal(round?.bidderCount, 0);
    assert.equal(database.publicEvents("b".repeat(64)).some((event) => "rawXdr" in event), false);
  } finally {
    database.close();
  }
});

test("stores confidential raw event locally but returns no decoded payload", () => {
  const database = new EvidenceDatabase(":memory:");
  try {
    database.insertEvent(
      base({
        id: "private-0",
        eventType: "set_spender",
        roundId: null,
        data: null,
        rawXdr: "encrypted-xdr",
      }),
    );
    const row = database.db
      .prepare("SELECT data_json AS dataJson, raw_xdr AS rawXdr FROM chain_events WHERE id = ?")
      .get("private-0") as { dataJson: null; rawXdr: string };
    assert.equal(row.dataJson, null);
    assert.equal(row.rawXdr, "encrypted-xdr");
  } finally {
    database.close();
  }
});
