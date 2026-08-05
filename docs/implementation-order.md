# QuietBook implementation order

This order follows the PRD's technical spike gate and protects the core auction invariants before product UI work begins.

## 1. P0 integration gate

- [x] Pin the OpenZeppelin confidential-token branch and reference demo revisions.
- [x] Prove a unique controller contract can register as a confidential account and act as a spender.
- [x] Read the live delegation and its allowance commitment from the token contract.
- [x] Construct the set-spender and spender-transfer witnesses in the QuietBook SDK.
- [x] Call a dedicated UltraHonk verifier from the market contract.

Local exit condition: complete. Testnet reproduction remains part of the evidence milestone.

## 2. P0 market state machine

- [x] Create immutable draft rounds.
- [x] Escrow the exact public RWA lot before opening.
- [x] Enforce allowlist eligibility and a live controller delegation.
- [x] Record one bidder registration per investor without bid values.
- [x] Freeze the ordered bidder set and participant-set hash at close.
- [x] Cover cancellation, no-sale, and one-time RWA reclaim paths.

## 3. P0 Max-Bid proof

- [x] Implement the fixed `N=3` Noir circuit.
- [x] Bind the round domain, ordered bidders, active flags, live allowance commitments, reserve, winner index, and settlement payment commitment.
- [x] Test winner positions, ties, reserve failure, wrong winner, payment mismatch, and padding.
- [x] Pin the generated circuit artifact and verification key.

## 4. P0 atomic settlement

- [x] Have the market load bidder order and commitments from trusted on-chain state.
- [x] Verify the Max-Bid proof through a dedicated verifier contract.
- [x] Invoke the controller's exact confidential spender transfer.
- [x] Deliver the public RWA lot in the same Soroban invocation.
- [x] Reject replay, revoked delegation, mismatched controller configuration, invalid winner, and duplicate settlement.

## 5. P0 evidence, then P1 product

- [x] Archive one local and one Testnet end-to-end run.
- [x] Create a reviewer evidence index before making public claims.
- Build the judge flow, issuer/investor/public views, and blocked unauthorized path.
- Add the auditor split view, then recipient-bound disclosure.

The app must never persist or emit plaintext bids in URLs, logs, analytics, public receipts, or evidence manifests.
