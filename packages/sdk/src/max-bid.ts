import { IDENTITY, commit, fieldIn, pointIn, type NoirInputs, type Point } from "@ctd/sdk";

export interface BidOpening {
  value: bigint;
  randomness: bigint;
  commitment?: Point;
}

export interface PaymentOpening {
  value: bigint;
  randomness: bigint;
  commitment: Point;
}

export interface MaxBidParams {
  roundDomain: bigint;
  bids: BidOpening[];
  reserve: bigint;
  payment: PaymentOpening;
}

export interface MaxBidWitness {
  inputs: NoirInputs;
  winnerIndex: number;
  winnerValue: bigint;
  commitments: [Point, Point, Point];
  active: [boolean, boolean, boolean];
}

export function buildMaxBidWitness(p: MaxBidParams): MaxBidWitness {
  if (p.roundDomain === 0n) throw new Error("round domain must be nonzero");
  if (p.bids.length === 0 || p.bids.length > 3) throw new Error("Max-Bid requires 1 to 3 bids");
  if (p.reserve < 0n) throw new Error("reserve must be non-negative");

  let winnerIndex = 0;
  for (let i = 0; i < p.bids.length; i += 1) {
    const bid = p.bids[i]!;
    if (bid.value < 0n || bid.value >= 1n << 127n) throw new RangeError("bid is outside i128 range");
    if (i > 0 && bid.value > p.bids[winnerIndex]!.value) winnerIndex = i;
  }
  const winnerValue = p.bids[winnerIndex]!.value;
  if (winnerValue < p.reserve) throw new Error("winning bid does not meet reserve");
  if (p.payment.value !== winnerValue) throw new Error("payment opening does not equal winning bid");
  const expectedPayment = commit(p.payment.value, p.payment.randomness);
  if (!expectedPayment.equals(p.payment.commitment)) {
    throw new Error("payment opening does not match settlement commitment");
  }

  const commitments = p.bids.map((bid) => {
    const expected = commit(bid.value, bid.randomness);
    if (bid.commitment && !expected.equals(bid.commitment)) {
      throw new Error("bid opening does not match allowance commitment");
    }
    return expected;
  });
  while (commitments.length < 3) commitments.push(IDENTITY);

  const values = p.bids.map((bid) => bid.value);
  const blindings = p.bids.map((bid) => bid.randomness);
  while (values.length < 3) values.push(0n);
  while (blindings.length < 3) blindings.push(0n);
  const active: [boolean, boolean, boolean] = [p.bids.length > 0, p.bids.length > 1, p.bids.length > 2];
  const fixedCommitments = commitments as [Point, Point, Point];

  const inputs = {
    round_domain: fieldIn(p.roundDomain),
    ...pointIn("c_0", fixedCommitments[0]),
    ...pointIn("c_1", fixedCommitments[1]),
    ...pointIn("c_2", fixedCommitments[2]),
    active_0: active[0],
    active_1: active[1],
    active_2: active[2],
    reserve: fieldIn(p.reserve),
    winner_index: fieldIn(BigInt(winnerIndex)),
    ...pointIn("payment", p.payment.commitment),
    bid_0: fieldIn(values[0]!),
    blind_0: fieldIn(blindings[0]!),
    bid_1: fieldIn(values[1]!),
    blind_1: fieldIn(blindings[1]!),
    bid_2: fieldIn(values[2]!),
    blind_2: fieldIn(blindings[2]!),
    payment_blind: fieldIn(p.payment.randomness),
  } as unknown as NoirInputs;

  return { inputs, winnerIndex, winnerValue, commitments: fixedCommitments, active };
}

