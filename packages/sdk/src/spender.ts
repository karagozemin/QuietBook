import {
  DOMAIN,
  H,
  commit,
  deriveAllowR,
  deriveSpendR,
  deriveTxBlind,
  dvkFromVkOp,
  encryptAllowance,
  encryptAmount,
  encryptBalance,
  encryptEscDvk,
  fieldIn,
  frAdd,
  pointIn,
  pointCoords,
  poseidonWithDomain,
  randomScalar,
  scalarMul,
  spongeSqueeze2,
  type KeyPair,
  type NoirInputs,
  type Point,
} from "@ctd/sdk";

const MAX_I128 = 1n << 127n;
const ECDH_SHARED_SECRET_DOMAIN = 13n;

// The pinned OpenZeppelin revision hashes both shared-point coordinates.
// The older reference demo returned only x, so its ecdh helper cannot be used.
function currentEcdh(scalar: bigint, point: Point): bigint {
  const shared = scalarMul(scalar, point);
  if (shared.is0()) throw new Error("ecdh produced the identity");
  const coordinates = pointCoords(shared);
  return poseidonWithDomain(ECDH_SHARED_SECRET_DOMAIN, [coordinates.x, coordinates.y]);
}

function assertAmount(value: bigint, label: string): void {
  if (value < 0n || value >= MAX_I128) {
    throw new RangeError(`${label} must be in [0, 2^127)`);
  }
}

export interface SetSpenderParams {
  ownerKeys: KeyPair;
  spendableValue: bigint;
  spendableRandomness: bigint;
  allowance: bigint;
  spenderKeys: KeyPair;
  spenderId: bigint;
  ownerAuditorKey: Point;
  sigma?: bigint;
  sigmaA?: bigint;
  rE?: bigint;
}

export interface SetSpenderWitness {
  inputs: NoirInputs;
  payload: {
    cSpendNew: Point;
    cA: Point;
    escrowedDvk: { rX: bigint; cipher: bigint };
    bTilde: bigint;
    aTilde: bigint;
    rE: Point;
    sigma: bigint;
    sigmaA: bigint;
    vAudS: bigint;
    bAudS: bigint;
  };
  delegation: { value: bigint; randomness: bigint; dvk: bigint; sigmaA: bigint; cA: Point };
  nextSpendable: { value: bigint; randomness: bigint; commitment: Point };
}

export function buildSetSpenderWitness(p: SetSpenderParams): SetSpenderWitness {
  assertAmount(p.spendableValue, "spendable value");
  assertAmount(p.allowance, "allowance");
  const nextValue = p.spendableValue - p.allowance;
  assertAmount(nextValue, "post-delegation spendable value");

  const sigma = p.sigma ?? randomScalar();
  const sigmaA = p.sigmaA ?? randomScalar();
  const rE = p.rE ?? randomScalar();
  const cSpend = commit(p.spendableValue, p.spendableRandomness);
  const nextRandomness = deriveSpendR(p.ownerKeys.vk, sigma);
  const cSpendNew = commit(nextValue, nextRandomness);
  const bTilde = encryptBalance(nextValue, p.ownerKeys.vk, sigma);

  const dvk = dvkFromVkOp(p.ownerKeys.vk, p.spenderId);
  const allowanceRandomness = deriveAllowR(dvk, sigmaA);
  const cA = commit(p.allowance, allowanceRandomness);
  const aTilde = encryptAllowance(p.allowance, dvk, sigmaA);

  const rEPoint = scalarMul(rE, H);
  const escrowShared = currentEcdh(rE, p.spenderKeys.Y);
  const escrowedDvk = { rX: rEPoint.toAffine().x, cipher: encryptEscDvk(dvk, escrowShared, p.spenderId) };

  const auditorShared = currentEcdh(rE, p.ownerAuditorKey);
  const auditorMasks = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, auditorShared, sigma);
  const vAudS = frAdd(p.allowance, auditorMasks[0]);
  const bAudS = frAdd(nextValue, auditorMasks[1]);

  const inputs: NoirInputs = {
    sk: fieldIn(p.ownerKeys.sk),
    v: fieldIn(p.spendableValue),
    r: fieldIn(p.spendableRandomness),
    v_a: fieldIn(p.allowance),
    r_e: fieldIn(rE),
    ...pointIn("c_spend", cSpend),
    ...pointIn("y", p.ownerKeys.Y),
    ...pointIn("y_op", p.spenderKeys.Y),
    op_i: fieldIn(p.spenderId),
    addr_f: fieldIn(p.ownerKeys.addrF),
    ...pointIn("k_aud_s", p.ownerAuditorKey),
    ...pointIn("c_spend_new", cSpendNew),
    ...pointIn("c_a", cA),
    escrowed_dvk_r_x: fieldIn(escrowedDvk.rX),
    escrowed_dvk_cipher: fieldIn(escrowedDvk.cipher),
    b_tilde: fieldIn(bTilde),
    a_tilde: fieldIn(aTilde),
    sigma: fieldIn(sigma),
    sigma_a: fieldIn(sigmaA),
    ...pointIn("r_e", rEPoint),
    v_tilde_aud_s: fieldIn(vAudS),
    b_tilde_aud_s: fieldIn(bAudS),
  };

  return {
    inputs,
    payload: { cSpendNew, cA, escrowedDvk, bTilde, aTilde, rE: rEPoint, sigma, sigmaA, vAudS, bAudS },
    delegation: { value: p.allowance, randomness: allowanceRandomness, dvk, sigmaA, cA },
    nextSpendable: { value: nextValue, randomness: nextRandomness, commitment: cSpendNew },
  };
}

export interface RevokeSpenderParams {
  ownerKeys: KeyPair;
  spendableValue: bigint;
  spendableRandomness: bigint;
  allowance: bigint;
  allowanceRandomness: bigint;
  allowanceSalt: bigint;
  spenderId: bigint;
  ownerAuditorKey: Point;
  sigma?: bigint;
  rE?: bigint;
}

export interface RevokeSpenderWitness {
  inputs: NoirInputs;
  payload: {
    cSpendNew: Point;
    bTilde: bigint;
    rE: Point;
    sigma: bigint;
    vAudS: bigint;
    bAudS: bigint;
  };
  nextSpendable: { value: bigint; randomness: bigint; commitment: Point };
}

export function buildRevokeSpenderWitness(p: RevokeSpenderParams): RevokeSpenderWitness {
  assertAmount(p.spendableValue, "spendable value");
  assertAmount(p.allowance, "allowance");
  const nextValue = p.spendableValue + p.allowance;
  assertAmount(nextValue, "post-reclaim spendable value");

  const delegationDvk = dvkFromVkOp(p.ownerKeys.vk, p.spenderId);
  const expectedAllowanceRandomness = deriveAllowR(delegationDvk, p.allowanceSalt);
  if (expectedAllowanceRandomness !== p.allowanceRandomness) {
    throw new Error("allowance opening does not match owner key, spender and salt");
  }

  const sigma = p.sigma ?? randomScalar();
  const rE = p.rE ?? randomScalar();
  const cSpend = commit(p.spendableValue, p.spendableRandomness);
  const cA = commit(p.allowance, p.allowanceRandomness);
  const nextRandomness = deriveSpendR(p.ownerKeys.vk, sigma);
  const cSpendNew = commit(nextValue, nextRandomness);
  const bTilde = encryptBalance(nextValue, p.ownerKeys.vk, sigma);
  const rEPoint = scalarMul(rE, H);
  const auditorShared = currentEcdh(rE, p.ownerAuditorKey);
  const auditorMasks = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, auditorShared, sigma);
  const vAudS = frAdd(p.allowance, auditorMasks[0]);
  const bAudS = frAdd(nextValue, auditorMasks[1]);

  const inputs: NoirInputs = {
    sk: fieldIn(p.ownerKeys.sk),
    v_a: fieldIn(p.allowance),
    r_a: fieldIn(p.allowanceRandomness),
    v_s: fieldIn(p.spendableValue),
    r_s: fieldIn(p.spendableRandomness),
    r_e: fieldIn(rE),
    ...pointIn("c_spend", cSpend),
    ...pointIn("c_a", cA),
    sigma_a: fieldIn(p.allowanceSalt),
    ...pointIn("y", p.ownerKeys.Y),
    op_i: fieldIn(p.spenderId),
    addr_f: fieldIn(p.ownerKeys.addrF),
    ...pointIn("k_aud_s", p.ownerAuditorKey),
    ...pointIn("c_spend_new", cSpendNew),
    b_tilde: fieldIn(bTilde),
    sigma: fieldIn(sigma),
    ...pointIn("r_e", rEPoint),
    v_tilde_aud_s: fieldIn(vAudS),
    b_tilde_aud_s: fieldIn(bAudS),
  };

  return {
    inputs,
    payload: { cSpendNew, bTilde, rE: rEPoint, sigma, vAudS, bAudS },
    nextSpendable: { value: nextValue, randomness: nextRandomness, commitment: cSpendNew },
  };
}

export interface SpenderTransferParams {
  spenderKeys: KeyPair;
  delegationDvk: bigint;
  allowance: bigint;
  allowanceRandomness: bigint;
  allowanceSalt: bigint;
  amount: bigint;
  recipientViewingKey: Point;
  recipientAuditorKey: Point;
  ownerAuditorKey: Point;
  nextAllowanceSalt?: bigint;
  rE?: bigint;
}

export interface SpenderTransferWitness {
  inputs: NoirInputs;
  payload: {
    cANew: Point;
    cTransfer: Point;
    rE: Point;
    vTilde: bigint;
    aTildeNew: bigint;
    sigmaANew: bigint;
    vAudR: bigint;
    rAudR: bigint;
    vAudS: bigint;
    aAudS: bigint;
  };
  paymentOpening: { value: bigint; randomness: bigint; commitment: Point };
  nextDelegation: { value: bigint; randomness: bigint; sigmaA: bigint; cA: Point };
}

export function buildSpenderTransferWitness(p: SpenderTransferParams): SpenderTransferWitness {
  assertAmount(p.allowance, "allowance");
  assertAmount(p.amount, "transfer amount");
  const nextValue = p.allowance - p.amount;
  assertAmount(nextValue, "post-transfer allowance");

  const expectedRandomness = deriveAllowR(p.delegationDvk, p.allowanceSalt);
  if (expectedRandomness !== p.allowanceRandomness) {
    throw new Error("allowance opening does not match delegation key and salt");
  }

  const sigmaANew = p.nextAllowanceSalt ?? randomScalar();
  if (sigmaANew === p.allowanceSalt) throw new Error("new allowance salt must rotate");
  const rE = p.rE ?? randomScalar();
  const cA = commit(p.allowance, p.allowanceRandomness);
  const rEPoint = scalarMul(rE, H);

  const recipientShared = currentEcdh(rE, p.recipientViewingKey);
  const transferRandomness = deriveTxBlind(recipientShared, p.allowanceSalt);
  const cTransfer = commit(p.amount, transferRandomness);
  const vTilde = encryptAmount(p.amount, recipientShared, p.allowanceSalt);

  const nextRandomness = deriveAllowR(p.delegationDvk, sigmaANew);
  const cANew = commit(nextValue, nextRandomness);
  const aTildeNew = encryptAllowance(nextValue, p.delegationDvk, sigmaANew);

  const recipientAuditorShared = currentEcdh(rE, p.recipientAuditorKey);
  const recipientMasks = spongeSqueeze2(
    DOMAIN.AUDITOR_RECIPIENT,
    recipientAuditorShared,
    p.allowanceSalt,
  );
  const ownerAuditorShared = currentEcdh(rE, p.ownerAuditorKey);
  const ownerMasks = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, ownerAuditorShared, p.allowanceSalt);
  const vAudR = frAdd(p.amount, recipientMasks[0]);
  const rAudR = frAdd(transferRandomness, recipientMasks[1]);
  const vAudS = frAdd(p.amount, ownerMasks[0]);
  const aAudS = frAdd(nextValue, ownerMasks[1]);

  const inputs: NoirInputs = {
    sk_op: fieldIn(p.spenderKeys.sk),
    dvk_i: fieldIn(p.delegationDvk),
    v_a: fieldIn(p.allowance),
    r_a: fieldIn(p.allowanceRandomness),
    v_transfer: fieldIn(p.amount),
    r_e: fieldIn(rE),
    ...pointIn("c_a", cA),
    sigma_a: fieldIn(p.allowanceSalt),
    ...pointIn("y_op", p.spenderKeys.Y),
    ...pointIn("pvk_recipient", p.recipientViewingKey),
    ...pointIn("k_aud_r", p.recipientAuditorKey),
    ...pointIn("k_aud_s", p.ownerAuditorKey),
    ...pointIn("c_a_new", cANew),
    ...pointIn("c_transfer", cTransfer),
    ...pointIn("r_e", rEPoint),
    v_tilde: fieldIn(vTilde),
    a_tilde_new: fieldIn(aTildeNew),
    sigma_a_new: fieldIn(sigmaANew),
    v_tilde_aud_r: fieldIn(vAudR),
    r_tilde_aud_r: fieldIn(rAudR),
    v_tilde_aud_s: fieldIn(vAudS),
    a_tilde_aud_s: fieldIn(aAudS),
  };

  return {
    inputs,
    payload: { cANew, cTransfer, rE: rEPoint, vTilde, aTildeNew, sigmaANew, vAudR, rAudR, vAudS, aAudS },
    paymentOpening: { value: p.amount, randomness: transferRandomness, commitment: cTransfer },
    nextDelegation: { value: nextValue, randomness: nextRandomness, sigmaA: sigmaANew, cA: cANew },
  };
}
