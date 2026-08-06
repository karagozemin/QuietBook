import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";


const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1_000;

type Challenge = {
  account: string;
  message: string;
  expiresAt: number;
};

type SessionPayload = {
  account: string;
  audience: string;
  expiresAt: number;
  issuedAt: number;
  version: 1;
};

function encode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function decodeSignature(value: string) {
  const normalized = value.trim();
  // 128 hex chars = 64-byte ed25519 signature.
  if (/^[0-9a-f]{128}$/i.test(normalized)) return Buffer.from(normalized, "hex");
  // Comma-separated byte array, e.g. a Uint8Array stringified as "12,34,...".
  if (/^\d{1,3}(,\d{1,3})+$/.test(normalized)) {
    return Buffer.from(normalized.split(",").map((byte) => Number(byte)));
  }
  // JSON payloads: a plain number array or a serialized Node Buffer object.
  if (normalized.startsWith("[") || normalized.startsWith("{")) {
    try {
      const parsed = JSON.parse(normalized) as number[] | { type?: string; data?: number[] };
      if (Array.isArray(parsed)) return Buffer.from(parsed);
      if (parsed?.type === "Buffer" && Array.isArray(parsed.data)) return Buffer.from(parsed.data);
    } catch {
      // fall through to base64 handling below
    }
  }
  // Default: base64 or base64url.
  return Buffer.from(normalized, "base64");
}


export class SandboxAuth {
  private readonly challenges = new Map<string, Challenge>();

  constructor(
    private readonly secret: string,
    private readonly audience: string,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 32) throw new Error("QUIETBOOK_SESSION_SECRET must contain at least 32 characters");
  }

  challenge(account: string) {
    Keypair.fromPublicKey(account);
    const nonce = randomBytes(24).toString("base64url");
    const issuedAt = this.now();
    const expiresAt = issuedAt + CHALLENGE_TTL_MS;
    const message = [
      "QuietBook Testnet sandbox",
      "Authorize this wallet for live-round API actions.",
      "This request does not submit a transaction or move funds.",
      `Account: ${account}`,
      `Audience: ${this.audience}`,
      `Nonce: ${nonce}`,
      `Issued at: ${new Date(issuedAt).toISOString()}`,
      `Expires at: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    this.challenges.set(nonce, { account, message, expiresAt });
    this.pruneChallenges();
    return { nonce, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  verifyChallenge(account: string, nonce: string, signature: string) {
    const challenge = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (!challenge || challenge.account !== account || challenge.expiresAt <= this.now()) {
      throw new Error("Wallet authorization challenge is invalid or expired");
    }
    const signatureBytes = decodeSignature(signature);
    // Freighter's signMessage behaviour varies by version:
    //   - older builds sign the raw UTF-8 message bytes;
    //   - some builds sign the SHA-256 hash of those bytes;
    //   - current builds follow SEP-0053 and sign
    //       SHA-256("Stellar Signed Message:\n" + message).
    // Accept every variant so wallet authorization works across Freighter versions.
    const messageBytes = Buffer.from(challenge.message, "utf8");
    const hashedBytes = createHash("sha256").update(messageBytes).digest();
    const sep53Prefix = Buffer.from("Stellar Signed Message:\n", "utf8");
    const sep53Bytes = Buffer.concat([sep53Prefix, messageBytes]);
    const sep53HashedBytes = createHash("sha256").update(sep53Bytes).digest();
    const keypair = Keypair.fromPublicKey(account);
    const candidates = [messageBytes, hashedBytes, sep53Bytes, sep53HashedBytes];
    const signatureValid = signatureBytes.length === 64
      && candidates.some((candidate) => keypair.verify(candidate, signatureBytes));
    if (!signatureValid) {
      throw new Error("Wallet authorization signature is invalid");
    }

    const issuedAt = this.now();
    const payload: SessionPayload = {
      account,
      audience: this.audience,
      issuedAt,
      expiresAt: issuedAt + SESSION_TTL_MS,
      version: 1,
    };
    return {
      token: this.sign(payload),
      account,
      expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }

  authenticate(header: string | undefined) {
    if (!header?.startsWith("Bearer ")) throw new Error("Wallet API session is required");
    const token = header.slice("Bearer ".length);
    const [payloadPart, signaturePart, extra] = token.split(".");
    if (!payloadPart || !signaturePart || extra) throw new Error("Wallet API session is invalid");
    const expected = Buffer.from(this.mac(payloadPart), "base64url");
    const provided = Buffer.from(signaturePart, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new Error("Wallet API session is invalid");
    }
    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as SessionPayload;
    } catch {
      throw new Error("Wallet API session is invalid");
    }
    if (payload.version !== 1 || payload.audience !== this.audience || payload.expiresAt <= this.now()) {
      throw new Error("Wallet API session is invalid or expired");
    }
    Keypair.fromPublicKey(payload.account);
    return payload.account;
  }

  private sign(payload: SessionPayload) {
    const encoded = encode(JSON.stringify(payload));
    return `${encoded}.${this.mac(encoded)}`;
  }

  private mac(payload: string) {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private pruneChallenges() {
    const now = this.now();
    for (const [nonce, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(nonce);
    }
    while (this.challenges.size > 5_000) {
      const oldest = this.challenges.keys().next().value as string | undefined;
      if (!oldest) break;
      this.challenges.delete(oldest);
    }
  }
}
