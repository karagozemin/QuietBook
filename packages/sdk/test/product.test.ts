import assert from "node:assert/strict";
import { xdr } from "@stellar/stellar-sdk";
import type { InvokeResult, Signer } from "@ctd/sdk";
import {
  QuietBookClient,
  encodeRoundConfig,
  parseConfidentialAccount,
  type ProductChain,
} from "../src/index.js";
import { buildFixture } from "./fixtures.js";

const calls: Array<{ contract: string; method: string; args: xdr.ScVal[] }> = [];
const roundId = "ab".repeat(32);
const signer: Signer = { publicKey: "G-TEST", async sign(value) { return value; } };
const chain: ProductChain = {
  async invoke(contract, method, args): Promise<InvokeResult> {
    calls.push({ contract, method, args });
    return {
      hash: method.padEnd(64, "0").slice(0, 64),
      status: "SUCCESS",
      returnValue: method === "create_round" || method === "create_and_open_round"
        ? xdr.ScVal.scvBytes(Buffer.from(roundId, "hex"))
        : undefined,
    };
  },
  async simulate(_contract, method) {
    return method === "get_bidders"
      ? xdr.ScVal.scvVec([])
      : xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("status"), val: xdr.ScVal.scvSymbol("Open") }),
        ]);
  },
};
const client = new QuietBookClient(chain, { market: "C-MARKET", confidentialToken: "C-TOKEN" });
const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const contract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const config = encodeRoundConfig({
  issuer: address,
  rwaToken: contract,
  rwaLot: 10n,
  confidentialToken: contract,
  controller: contract,
  eligibilityPolicy: contract,
  maxBidVerifier: contract,
  auditorId: 0,
  reservePublic: 8n,
  bidDeadlineLedger: 100,
  settlementDeadlineLedger: 200,
});
assert.equal(config.switch(), xdr.ScValType.scvMap());

const account = parseConfidentialAccount(xdr.ScVal.scvMap([
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("auditor_id"), val: xdr.ScVal.scvU32(7) }),
  ...["spendable_commitment", "receiving_commitment", "spending_public_key", "viewing_public_key"]
    .map((key, index) => new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol(key),
      val: xdr.ScVal.scvBytes(new Uint8Array([index + 1])),
    })),
]));
assert.equal(account.auditorId, 7);
assert.deepEqual(account.spendableCommitment, new Uint8Array([1]));

const created = await client.createRound({
  issuer: address,
  rwaToken: contract,
  rwaLot: 10n,
  confidentialToken: contract,
  controller: contract,
  eligibilityPolicy: contract,
  maxBidVerifier: contract,
  auditorId: 0,
  reservePublic: 8n,
  bidDeadlineLedger: 100,
  settlementDeadlineLedger: 200,
}, signer);
assert.equal(created.roundId, roundId);

const atomic = await client.createAndOpenRound({
  issuer: address,
  rwaToken: contract,
  rwaLot: 10n,
  confidentialToken: contract,
  controller: contract,
  eligibilityPolicy: contract,
  maxBidVerifier: contract,
  auditorId: 0,
  reservePublic: 8n,
  bidDeadlineLedger: 100,
  settlementDeadlineLedger: 200,
}, 0, xdr.ScVal.scvBytes(new Uint8Array([1])), signer);
assert.equal(atomic.roundId, roundId);

const fixture = buildFixture();
await client.submitSealedBid({
  roundId,
  bidder: address,
  controller: contract,
  settlementDeadlineLedger: 200,
  witness: fixture.setSpender,
  proof: new Uint8Array([1]),
}, signer);
await client.withdrawBid(roundId, {
  account: address,
  controller: contract,
  witness: fixture.revokeSpender,
  proof: new Uint8Array([2]),
}, signer);
await client.reclaimBid({
  account: address,
  controller: contract,
  witness: fixture.revokeSpender,
  proof: new Uint8Array([3]),
}, signer);

assert.deepEqual(
  calls.map((call) => call.method),
  ["create_round", "create_and_open_round", "set_spender", "register_bid", "withdraw_bid", "revoke_spender"],
);
assert.equal(calls[4]!.contract, "C-MARKET");
assert.equal(calls[5]!.contract, "C-TOKEN");

console.log("product orchestration checks passed");
