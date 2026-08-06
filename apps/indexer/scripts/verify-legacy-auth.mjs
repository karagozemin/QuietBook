import { Keypair } from "@stellar/stellar-sdk";

const BASE = process.env.BASE ?? "https://api.139-59-153-164.sslip.io";
const w = Keypair.random();

async function post(p, b) {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const c = await post("/api/auth/challenge", { account: w.publicKey() });
if (c.status !== 200) {
  console.error("challenge failed", c);
  process.exit(1);
}

// Legacy path: sign the raw UTF-8 message bytes (no sha256 pre-hash).
const sig = w.sign(Buffer.from(c.json.message, "utf8")).toString("base64");
const v = await post("/api/auth/verify", {
  account: w.publicKey(),
  nonce: c.json.nonce,
  signature: sig,
});

if (v.status === 200 && v.json?.token) {
  console.log("LEGACY_RAW_MESSAGE_OK: raw-message signature still accepted");
  process.exit(0);
}
console.error("LEGACY_FAIL", v);
process.exit(1);
