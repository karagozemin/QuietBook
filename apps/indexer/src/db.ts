import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type IndexedEvent = {
  id: string;
  contractId: string;
  ledger: number;
  txHash: string;
  eventType: string;
  roundId: string | null;
  actor: string | null;
  data: Record<string, unknown> | null;
  rawXdr: string;
};

export type PublicRound = {
  roundId: string;
  marketId: string;
  issuer: string | null;
  status: string;
  bidderCount: number;
  winner: string | null;
  participantSetHash: string | null;
  proofHash: string | null;
  terms: Record<string, unknown> | null;
  rwaEscrowed: boolean;
  lastLedger: number;
};

export class EvidenceDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chain_events (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        ledger INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        event_type TEXT NOT NULL,
        round_id TEXT,
        actor TEXT,
        data_json TEXT,
        raw_xdr TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chain_events_round ON chain_events(round_id, ledger, id);
      CREATE INDEX IF NOT EXISTS chain_events_contract ON chain_events(contract_id, ledger, id);
      CREATE TABLE IF NOT EXISTS rounds (
        round_id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        issuer TEXT,
        status TEXT NOT NULL,
        bidder_count INTEGER NOT NULL DEFAULT 0,
        winner TEXT,
        participant_set_hash TEXT,
        proof_hash TEXT,
        terms_json TEXT,
        rwa_escrowed INTEGER NOT NULL DEFAULT 0,
        last_ledger INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_state (
        source TEXT PRIMARY KEY,
        cursor TEXT,
        latest_ledger INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  insertEvent(event: IndexedEvent): boolean {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO chain_events
          (id, contract_id, ledger, tx_hash, event_type, round_id, actor, data_json, raw_xdr, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.contractId,
        event.ledger,
        event.txHash,
        event.eventType,
        event.roundId,
        event.actor,
        event.data ? JSON.stringify(event.data) : null,
        event.rawXdr,
        new Date().toISOString(),
      );
    if (Number(result.changes) === 0) return false;
    this.applyRoundEvent(event);
    return true;
  }

  private applyRoundEvent(event: IndexedEvent) {
    if (!event.roundId || !event.data) return;
    const data = event.data;
    if (event.eventType === "round_created") {
      const config = data.config as Record<string, unknown>;
      this.db.prepare(`
        INSERT OR REPLACE INTO rounds
          (round_id, market_id, issuer, status, bidder_count, terms_json, rwa_escrowed, last_ledger)
        VALUES (?, ?, ?, 'Draft', 0, ?, 0, ?)
      `).run(event.roundId, event.contractId, event.actor, JSON.stringify(config), event.ledger);
      return;
    }
    const update = (sql: string, ...values: Array<string | number | null>) =>
      this.db.prepare(`${sql}, last_ledger = ? WHERE round_id = ?`).run(
        ...values,
        event.ledger,
        event.roundId,
      );
    switch (event.eventType) {
      case "rwa_funded":
        update("UPDATE rounds SET rwa_escrowed = 1");
        break;
      case "round_opened":
        update("UPDATE rounds SET status = 'Open'");
        break;
      case "bid_registered":
        update("UPDATE rounds SET bidder_count = bidder_count + 1");
        break;
      case "bid_withdrawn":
        update("UPDATE rounds SET bidder_count = MAX(0, bidder_count - 1)");
        break;
      case "round_closed":
        update(
          "UPDATE rounds SET status = 'Closed', bidder_count = ?, participant_set_hash = ?",
          Number(data.bidder_count),
          String(data.participant_set_hash),
        );
        break;
      case "winner_proven":
        update(
          "UPDATE rounds SET winner = ?, proof_hash = ?, participant_set_hash = ?",
          event.actor,
          String(data.proof_hash),
          String(data.participant_set_hash),
        );
        break;
      case "round_settled":
        update(
          "UPDATE rounds SET status = 'Settled', winner = ?, proof_hash = ?",
          event.actor,
          String(data.proof_hash),
        );
        break;
      case "round_failed":
        update("UPDATE rounds SET status = 'Failed'");
        break;
      case "rwa_reclaimed":
        update("UPDATE rounds SET status = 'Cancelled', rwa_escrowed = 0");
        break;
    }
  }

  setSyncState(source: string, cursor: string | null, latestLedger: number) {
    this.db.prepare(`
      INSERT INTO sync_state (source, cursor, latest_ledger, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        cursor = excluded.cursor,
        latest_ledger = excluded.latest_ledger,
        updated_at = excluded.updated_at
    `).run(source, cursor, latestLedger, new Date().toISOString());
  }

  syncState(source: string) {
    return this.db
      .prepare("SELECT cursor, latest_ledger AS latestLedger FROM sync_state WHERE source = ?")
      .get(source) as { cursor: string | null; latestLedger: number } | undefined;
  }

  health() {
    const events = this.db.prepare("SELECT COUNT(*) AS count FROM chain_events").get() as {
      count: number;
    };
    const rounds = this.db.prepare("SELECT COUNT(*) AS count FROM rounds").get() as {
      count: number;
    };
    const sources = this.db
      .prepare("SELECT source, latest_ledger AS latestLedger, updated_at AS updatedAt FROM sync_state")
      .all();
    return { events: Number(events.count), rounds: Number(rounds.count), sources };
  }

  listRounds() {
    return this.db
      .prepare(`
        SELECT round_id AS roundId, market_id AS marketId, issuer, status,
          bidder_count AS bidderCount, winner, participant_set_hash AS participantSetHash,
          proof_hash AS proofHash, terms_json AS termsJson, rwa_escrowed AS rwaEscrowed,
          last_ledger AS lastLedger
        FROM rounds ORDER BY last_ledger DESC
      `)
      .all()
      .map(parseRound);
  }

  round(roundId: string) {
    const row = this.db
      .prepare(`
        SELECT round_id AS roundId, market_id AS marketId, issuer, status,
          bidder_count AS bidderCount, winner, participant_set_hash AS participantSetHash,
          proof_hash AS proofHash, terms_json AS termsJson, rwa_escrowed AS rwaEscrowed,
          last_ledger AS lastLedger
        FROM rounds WHERE round_id = ?
      `)
      .get(roundId);
    return row ? parseRound(row) : null;
  }

  publicEvents(roundId: string) {
    return this.db
      .prepare(`
        SELECT id, contract_id AS contractId, ledger, tx_hash AS txHash,
          event_type AS eventType, round_id AS roundId, actor, data_json AS dataJson
        FROM chain_events WHERE round_id = ? ORDER BY ledger, id
      `)
      .all(roundId)
      .map((row) => {
        const event = row as Record<string, unknown>;
        return { ...event, data: event.dataJson ? JSON.parse(String(event.dataJson)) : null, dataJson: undefined };
      });
  }
}

function parseRound(value: unknown): PublicRound {
  const row = value as Record<string, unknown>;
  return {
    roundId: String(row.roundId),
    marketId: String(row.marketId),
    issuer: row.issuer ? String(row.issuer) : null,
    status: String(row.status),
    bidderCount: Number(row.bidderCount),
    winner: row.winner ? String(row.winner) : null,
    participantSetHash: row.participantSetHash ? String(row.participantSetHash) : null,
    proofHash: row.proofHash ? String(row.proofHash) : null,
    rwaEscrowed: Boolean(row.rwaEscrowed),
    terms: row.termsJson ? JSON.parse(String(row.termsJson)) : null,
    lastLedger: Number(row.lastLedger),
  };
}
