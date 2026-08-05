import { H, deriveKeys, scalarMul } from "@ctd/sdk";
import { buildSetSpenderWitness, buildSpenderTransferWitness } from "../src/index.js";

export function buildFixture() {
  const addrF = 0x12345n;
  const ownerKeys = deriveKeys(0xabcden, addrF);
  const spenderKeys = deriveKeys(0xdeadn, addrF);
  const recipientKeys = deriveKeys(0xbeefn, addrF);
  const ownerAuditorKey = scalarMul(0xc0ffeen, H);
  const recipientAuditorKey = scalarMul(0xc0ffee01n, H);

  const setSpender = buildSetSpenderWitness({
    ownerKeys,
    spendableValue: 20_000n,
    spendableRandomness: 0x777n,
    allowance: 10_100n,
    spenderKeys,
    spenderId: 0x5151n,
    ownerAuditorKey,
    sigma: 0x111n,
    sigmaA: 0x222n,
    rE: 0x333n,
  });

  const spenderTransfer = buildSpenderTransferWitness({
    spenderKeys,
    delegationDvk: setSpender.delegation.dvk,
    allowance: setSpender.delegation.value,
    allowanceRandomness: setSpender.delegation.randomness,
    allowanceSalt: setSpender.delegation.sigmaA,
    amount: 10_100n,
    recipientViewingKey: recipientKeys.PVK,
    recipientAuditorKey,
    ownerAuditorKey,
    nextAllowanceSalt: 0x444n,
    rE: 0x555n,
  });

  return { setSpender, spenderTransfer };
}

