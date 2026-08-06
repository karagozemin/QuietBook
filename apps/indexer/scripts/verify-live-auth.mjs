import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

const BASE = process.env.BASE ?? "https://api.139-59-153-164.sslip.io";
const wallet = Keypair.random();

async function post(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const challenge = await post("/api/auth/challenge", { account: wallet.publicKey() });
if (challenge.status !== 200) {
  console.error("challenge failed", challenge);
  process.exit(1);
}

// Simulate Freighter: sign the SHA-256 hash of the UTF-8 message.
const hashed = createHash("sha256").update(Buffer.from(challenge.json.message, "utf8")).digest();
const signature = wallet.sign(hashed).toString("base64");

const verify = await post("/api/auth/verify", {
  account: wallet.publicKey(),
  nonce: challenge.json.nonce,
  signature,
});

if (verify.status === 200 && verify.json.token) {
  console.log("LIVE_AUTH_OK: Freighter-style sha256(message) signature accepted");
  console.log("session expiresAt:", verify.json.expiresAt);
  process.exit(0);
}
console.error("LIVE_AUTH_FAIL", verify);
process.exit(1);
