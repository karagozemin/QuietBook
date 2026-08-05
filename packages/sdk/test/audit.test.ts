import assert from "node:assert/strict";
import { H, deriveKeys, scalarMul } from "@ctd/sdk";
import {
  buildSetSpenderWitness,
  buildSpenderTransferWitness,
  decryptAllowanceEvent,
  decryptSpenderTransferEvent,
} from "../src/index.js";

const secret = 987654321n;
const auditorKey = scalarMul(secret, H);
const owner = deriveKeys(123n, 456n);
const spender = deriveKeys(789n, 456n);
const recipient = deriveKeys(101112n, 456n);
const set = buildSetSpenderWitness({
  ownerKeys: owner,
  spendableValue: 200n,
  spendableRandomness: 17n,
  allowance: 120n,
  spenderKeys: spender,
  spenderId: 919n,
  ownerAuditorKey: auditorKey,
});
const setEvent = {
  type: "set_spender" as const,
  ledger: 1,
  txHash: "a".repeat(64),
  eventId: "event-1",
  account: "GOWNER",
  spender: "CSPENDER",
  rE: set.payload.rE,
  sigma: set.payload.sigma,
  vAudS: set.payload.vAudS,
  bAudS: set.payload.bAudS,
};
assert.deepEqual(decryptAllowanceEvent(secret, setEvent), {
  allowance: 120n,
  ownerPostBalance: 80n,
});

const transfer = buildSpenderTransferWitness({
  spenderKeys: spender,
  delegationDvk: set.delegation.dvk,
  allowance: set.delegation.value,
  allowanceRandomness: set.delegation.randomness,
  allowanceSalt: set.delegation.sigmaA,
  amount: 120n,
  recipientViewingKey: recipient.PVK,
  recipientAuditorKey: auditorKey,
  ownerAuditorKey: auditorKey,
});
const transferEvent = {
  type: "spender_transfer" as const,
  ledger: 2,
  txHash: "b".repeat(64),
  eventId: "event-2",
  spender: "CSPENDER",
  from: "GOWNER",
  to: "GRECIPIENT",
  rE: transfer.payload.rE,
  sigmaA: set.delegation.sigmaA,
  vTilde: transfer.payload.vTilde,
  vAudR: transfer.payload.vAudR,
  rAudR: transfer.payload.rAudR,
  vAudS: transfer.payload.vAudS,
  aAudS: transfer.payload.aAudS,
};
assert.deepEqual(decryptSpenderTransferEvent(secret, transferEvent), {
  amount: 120n,
  recipientAmount: 120n,
  remainingAllowance: 0n,
  transferRandomness: transfer.paymentOpening.randomness,
  channelsAgree: true,
});
assert.equal(decryptSpenderTransferEvent(secret + 1n, transferEvent).channelsAgree, false);

console.log("current auditor event decryption checks passed");
