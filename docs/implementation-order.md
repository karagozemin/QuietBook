# QuietBook implementation order

This order follows the PRD's technical spike gate and protects the core auction invariants before product UI work begins.

## 1. P0 integration gate

- Pin the OpenZeppelin confidential-token branch and reference demo revisions.
- Prove a unique controller contract can register as a confidential account and act as a spender.
- Read the live delegation and its allowance commitment from the token contract.
- Construct the set-spender and spender-transfer witnesses in the QuietBook SDK.
- Call a dedicated UltraHonk verifier from the market contract.

Exit condition: all four PRD integration facts pass locally with real proof artifacts, then on Stellar Testnet.

## 2. P0 market state machine

- Create immutable draft rounds.
- Escrow the exact public RWA lot before opening.
- Enforce allowlist eligibility and a live controller delegation.
- Record one bidder registration per investor without bid values.
- Freeze the ordered bidder set and participant-set hash at close.
- Cover cancellation, no-sale, and one-time RWA reclaim paths.

## 3. P0 Max-Bid proof

- Implement the fixed `N=3` Noir circuit.
- Bind the round domain, ordered bidders, active flags, live allowance commitments, reserve, and winner index.
- Test every bid permutation, ties, reserve failure, wrong openings, omitted/reordered bidders, and padding.
- Pin the generated circuit artifact and verification key.

## 4. P0 atomic settlement

- Have the market load bidder order and commitments from trusted on-chain state.
- Verify the Max-Bid proof through a dedicated verifier contract.
- Invoke the controller's exact confidential spender transfer.
- Deliver the public RWA lot in the same Soroban invocation.
- Reject replay, stale delegation, wrong token/recipient, and duplicate settlement.

## 5. P0 evidence, then P1 product

- Archive one local and one Testnet end-to-end run.
- Create a reviewer evidence index before making public claims.
- Build the judge flow, issuer/investor/public views, and blocked unauthorized path.
- Add the auditor split view, then recipient-bound disclosure.

The app must never persist or emit plaintext bids in URLs, logs, analytics, public receipts, or evidence manifests.

