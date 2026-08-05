import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proverFromArtifact } from "@ctd/sdk";
import { buildFixture } from "../test/fixtures.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const circuits = join(root, "circuits");
const artifact = JSON.parse(readFileSync(join(circuits, "max_bid.json"), "utf8"));
const prover = proverFromArtifact(artifact);

try {
  const key = await prover.verificationKey();
  if (key.length !== 1760) throw new Error(`unexpected verification key length: ${key.length}`);
  writeFileSync(join(circuits, "max_bid.vk.bin"), key);
  const fixture = buildFixture();
  const proof = await prover.prove(fixture.maxBid.inputs);
  if (!(await prover.verify(proof))) throw new Error("generated Max-Bid fixture proof did not verify");
  const publicInputBytes = Buffer.concat(
    proof.publicInputs.map((value) => Buffer.from(value.replace(/^0x/, "").padStart(64, "0"), "hex")),
  );
  writeFileSync(join(circuits, "max_bid.proof.bin"), proof.proof);
  writeFileSync(join(circuits, "max_bid.public-inputs.bin"), publicInputBytes);
  writeFileSync(
    join(circuits, "max_bid.vk.json"),
    `${JSON.stringify(
      {
        circuit: "circuit_max_bid",
        transcript: "keccak",
        bytes: key.length,
        sha256: createHash("sha256").update(key).digest("hex"),
        fixture_proof_sha256: createHash("sha256").update(proof.proof).digest("hex"),
        public_inputs: proof.publicInputs.length,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `max_bid verification key: ${key.length} bytes; fixture proof: ${proof.proof.length} bytes`,
  );
} finally {
  await prover.destroy();
}
