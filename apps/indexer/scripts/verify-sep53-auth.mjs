import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

// End-to-end live check for the SEP-0053 Freighter signing path.
// Freighter's signMessage produces sign(sha256("Stellar Signed Message:\n" + message)).
const BASE = process.env.BASE ?? "https://api.139-59-153-164.sslip.io";
const SEP53_PREFIX = "Stellar Signed Message:\n";

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

async function run(label, buildSignature) {
  const wallet = Keypair.random();
  const challenge = await post("/api/auth/challenge", { account: wallet.publicKey() });
  if (challenge.status !== 200) {
    console.error(`${label} FAIL: challenge`, challenge);
    return false;
  }
  const signature = buildSignature(wallet, challenge.json.message);
  const verify = await post("/api/auth/verify", {
    account: wallet.publicKey(),
    nonce: challenge.json.nonce,
    signature,
  });
  if (verify.status === 200 && verify.json.token) {
    console.log(`${label} OK (expiresAt ${verify.json.expiresAt})`);
    return true;
  }
  console.error(`${label} FAIL`, verify);
  return false;
}

const results = [];

// 1. SEP-53: sign(sha256(prefix + message)) — the actual Freighter behaviour.
results.push(await run("SEP53_PREFIX_SHA256", (wallet, message) => {
  const prefixed = Buffer.concat([
    Buffer.from(SEP53_PREFIX, "utf8"),
    Buffer.from(message, "utf8"),
  ]);
  const hashed = createHash("sha256").update(prefixed).digest();
  return wallet.sign(hashed).toString("base64");
}));

// 2. Legacy sha256(message) — must still be accepted.
results.push(await run("LEGACY_SHA256", (wallet, message) => {
  const hashed = createHash("sha256").update(Buffer.from(message, "utf8")).digest();
  return wallet.sign(hashed).toString("base64");
}));

// 3. Raw message signature — must still be accepted.
results.push(await run("RAW_MESSAGE", (wallet, message) => {
  return wallet.sign(Buffer.from(message, "utf8")).toString("base64");
}));

if (results.every(Boolean)) {
  console.log("ALL_LIVE_AUTH_VARIANTS_OK");
  process.exit(0);
}
process.exit(1);
