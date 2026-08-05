import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proverFromArtifact } from "@ctd/sdk";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const circuits = join(root, "circuits");
const keys = join(circuits, "vks");
const names = [
  "register",
  "withdraw",
  "transfer",
  "spender_transfer",
  "set_spender",
  "revoke_spender",
] as const;

mkdirSync(keys, { recursive: true });

for (const name of names) {
  const artifact = JSON.parse(readFileSync(join(circuits, `${name}.json`), "utf8"));
  const prover = proverFromArtifact(artifact);
  try {
    const key = await prover.verificationKey();
    if (key.length !== 1760) {
      throw new Error(`${name}: unexpected verification key length ${key.length}`);
    }
    writeFileSync(join(keys, `${name}.vk.bin`), key);
    writeFileSync(
      join(keys, `${name}.vk.json`),
      `${JSON.stringify(
        {
          circuit: `circuit_${name}`,
          transcript: "keccak",
          bytes: key.length,
          sha256: createHash("sha256").update(key).digest("hex"),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`${name}: ${key.length}-byte verification key`);
  } finally {
    await prover.destroy();
  }
}
