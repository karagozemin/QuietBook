import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

import { SandboxAuth } from "../src/auth.js";
import { RateLimiter } from "../src/rate-limit.js";

const secret = "test-session-secret-that-is-longer-than-thirty-two-characters";

test("issues a one-use wallet session and rejects tampering", () => {
  let now = Date.parse("2026-08-06T12:00:00.000Z");
  const wallet = Keypair.random();
  const auth = new SandboxAuth(secret, "https://api.quietbook.test", () => now);
  const challenge = auth.challenge(wallet.publicKey());
  const signature = wallet.sign(Buffer.from(challenge.message)).toString("base64");
  const session = auth.verifyChallenge(wallet.publicKey(), challenge.nonce, signature);

  assert.equal(auth.authenticate(`Bearer ${session.token}`), wallet.publicKey());
  assert.throws(() => auth.verifyChallenge(wallet.publicKey(), challenge.nonce, signature), /invalid or expired/);
  assert.throws(() => auth.authenticate(`Bearer ${session.token}x`), /invalid/);

  now += (2 * 60 * 60 * 1_000) + 1;
  assert.throws(() => auth.authenticate(`Bearer ${session.token}`), /expired/);
});

test("accepts a Freighter signature over the sha256 hash of the message", () => {
  const wallet = Keypair.random();
  const auth = new SandboxAuth(secret, "https://api.quietbook.test");
  const challenge = auth.challenge(wallet.publicKey());
  const hashed = createHash("sha256").update(Buffer.from(challenge.message, "utf8")).digest();
  const signature = wallet.sign(hashed).toString("base64");
  const session = auth.verifyChallenge(wallet.publicKey(), challenge.nonce, signature);
  assert.equal(auth.authenticate(`Bearer ${session.token}`), wallet.publicKey());
});

test("accepts a SEP-0053 Freighter signature (Stellar Signed Message prefix + sha256)", () => {
  const wallet = Keypair.random();
  const auth = new SandboxAuth(secret, "https://api.quietbook.test");
  const challenge = auth.challenge(wallet.publicKey());
  const prefixed = Buffer.concat([
    Buffer.from("Stellar Signed Message:\n", "utf8"),
    Buffer.from(challenge.message, "utf8"),
  ]);
  const hashed = createHash("sha256").update(prefixed).digest();
  const signature = wallet.sign(hashed).toString("base64");
  const session = auth.verifyChallenge(wallet.publicKey(), challenge.nonce, signature);
  assert.equal(auth.authenticate(`Bearer ${session.token}`), wallet.publicKey());
});

test("accepts a signature serialized as a comma-separated byte array", () => {
  const wallet = Keypair.random();
  const auth = new SandboxAuth(secret, "https://api.quietbook.test");
  const challenge = auth.challenge(wallet.publicKey());
  const raw = wallet.sign(Buffer.from(challenge.message));
  const signature = Array.from(raw).join(",");
  const session = auth.verifyChallenge(wallet.publicKey(), challenge.nonce, signature);
  assert.equal(auth.authenticate(`Bearer ${session.token}`), wallet.publicKey());
});

test("accepts a signature serialized as a JSON number array", () => {
  const wallet = Keypair.random();
  const auth = new SandboxAuth(secret, "https://api.quietbook.test");
  const challenge = auth.challenge(wallet.publicKey());
  const raw = wallet.sign(Buffer.from(challenge.message));
  const signature = JSON.stringify(Array.from(raw));
  const session = auth.verifyChallenge(wallet.publicKey(), challenge.nonce, signature);
  assert.equal(auth.authenticate(`Bearer ${session.token}`), wallet.publicKey());
});

test("accepts a signature serialized as a Node Buffer object", () => {
  const wallet = Keypair.random();
  const auth = new SandboxAuth(secret, "https://api.quietbook.test");
  const challenge = auth.challenge(wallet.publicKey());
  const raw = wallet.sign(Buffer.from(challenge.message));
  const signature = JSON.stringify({ type: "Buffer", data: Array.from(raw) });
  const session = auth.verifyChallenge(wallet.publicKey(), challenge.nonce, signature);
  assert.equal(auth.authenticate(`Bearer ${session.token}`), wallet.publicKey());
});

test("rejects a signature from a different wallet", () => {


  const wallet = Keypair.random();
  const attacker = Keypair.random();
  const auth = new SandboxAuth(secret, "https://api.quietbook.test");
  const challenge = auth.challenge(wallet.publicKey());
  const signature = attacker.sign(Buffer.from(challenge.message)).toString("base64");
  assert.throws(
    () => auth.verifyChallenge(wallet.publicKey(), challenge.nonce, signature),
    /signature is invalid/,
  );
});

test("rate limiter returns a bounded retry window", () => {
  let now = 1_000;
  const limiter = new RateLimiter(2, 10_000, () => now);
  assert.equal(limiter.consume("wallet").allowed, true);
  assert.equal(limiter.consume("wallet").allowed, true);
  assert.deepEqual(limiter.consume("wallet"), { allowed: false, retryAfter: 10 });
  now += 10_000;
  assert.equal(limiter.consume("wallet").allowed, true);
});
