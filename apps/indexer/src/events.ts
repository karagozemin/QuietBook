import { scValToNative, type rpc } from "@stellar/stellar-sdk";
import { marketContracts } from "./config.js";
import type { IndexedEvent } from "./db.js";

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

function topicValue(event: rpc.Api.EventResponse, index: number) {
  const value = event.topic[index];
  return value ? jsonSafe(scValToNative(value)) : null;
}

export function normalizeEvent(event: rpc.Api.EventResponse): IndexedEvent {
  const contractId = String(event.contractId);
  const publicMarketEvent = marketContracts.includes(contractId);
  const roundTopic = publicMarketEvent ? topicValue(event, 1) : null;
  const actorTopic = topicValue(event, publicMarketEvent ? 2 : 1);
  return {
    id: event.id,
    contractId,
    ledger: event.ledger,
    txHash: event.txHash,
    eventType: event.topic[0]?.sym().toString() ?? "unknown",
    roundId: typeof roundTopic === "string" ? roundTopic : null,
    actor: typeof actorTopic === "string" ? actorTopic : null,
    data: publicMarketEvent
      ? (jsonSafe(scValToNative(event.value)) as Record<string, unknown>)
      : null,
    rawXdr: JSON.stringify({
      topic: event.topic.map((item) => item.toXDR("base64")),
      value: event.value.toXDR("base64"),
    }),
  };
}
