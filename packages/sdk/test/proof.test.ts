import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proverFromArtifact } from "@ctd/sdk";
import { buildFixture } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const circuits = join(here, "..", "circuits");
const fixture = buildFixture();

async function prove(name: string, inputs: Record<string, string>, expectedPublicInputs = 24): Promise<void> {
  const artifact = JSON.parse(readFileSync(join(circuits, `${name}.json`), "utf8"));
  const prover = proverFromArtifact(artifact);
  try {
    const result = await prover.prove(inputs);
    assert.equal(result.publicInputs.length, expectedPublicInputs);
    assert.equal(await prover.verify(result), true);
    console.log(`${name}: ${result.proof.length} byte proof verified`);
  } finally {
    await prover.destroy();
  }
}

await prove("set_spender", fixture.setSpender.inputs);
await prove("spender_transfer", fixture.spenderTransfer.inputs);
await prove("max_bid", fixture.maxBid.inputs, 14);
