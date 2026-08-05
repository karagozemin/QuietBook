import assert from "node:assert/strict";
import { xdr } from "@stellar/stellar-sdk";
import { encodeSetSpenderData, encodeSpenderTransferData } from "../src/index.js";
import { buildFixture } from "./fixtures.js";

const fixture = buildFixture();

assert.equal(fixture.setSpender.delegation.value, 10_100n);
assert.equal(fixture.setSpender.nextSpendable.value, 9_900n);
assert.equal(fixture.spenderTransfer.nextDelegation.value, 0n);
assert.equal(fixture.maxBid.winnerIndex, 0);
assert.equal(fixture.maxBid.winnerValue, 10_100n);
assert.notDeepEqual(
  fixture.setSpender.delegation.cA.toAffine(),
  fixture.spenderTransfer.nextDelegation.cA.toAffine(),
);

for (const encoded of [
  encodeSetSpenderData(fixture.setSpender, new Uint8Array([1, 2, 3])),
  encodeSpenderTransferData(fixture.spenderTransfer, new Uint8Array([4, 5, 6])),
]) {
  const outer = xdr.ScVal.fromXDR(encoded.bytes(), "raw");
  assert.equal(outer.switch(), xdr.ScValType.scvMap());
}

console.log("spender witness and current XDR payload checks passed");
