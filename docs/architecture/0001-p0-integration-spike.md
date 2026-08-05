# ADR 0001: P0 confidential-token integration baseline

Status: accepted for the first implementation slice

## Pinned sources

| Dependency | Revision |
| --- | --- |
| OpenZeppelin `stellar-contracts`, `feat/confidential-verifier-ultrahonk` | `98090b3e59785454f55b3617992c2f84250c7173` |
| `stellar-confidential-token-demo` | `9500ed774b13b08b5fe99370b60de3479edb492b` |
| Soroban UltraHonk fork used by the pinned OpenZeppelin revision | `5e9b4d995ec43ed1953cf89cfd738df6471e4b93` |

All three are pre-release and unaudited. QuietBook remains Testnet-only.

## Findings

1. The confidential token exposes `set_spender`, `is_spender`, `get_spender_delegation`, `confidential_transfer_from`, and `revoke_spender`.
2. A spender must first be a registered confidential account because `set_spender` encrypts delegation viewing material to the spender's registered spending key.
3. `get_spender_delegation` exposes the current allowance commitment, encrypted allowance, escrowed delegation viewing key, allowance salt, and expiry. The market only needs the commitment and expiry; it must not store an opening or plaintext amount.
4. A controller contract may authenticate direct confidential-token calls as its own address. Its constructor binds the market, token, issuer recipient, and settlement deadline so the off-chain operator cannot redirect payment.
5. The OpenZeppelin verifier already demonstrates cross-contract UltraHonk verification. QuietBook uses a dedicated verifier because the upstream `CircuitType` enum has no Max-Bid variant. Its constructor validates and stores the immutable Max-Bid verification key.
6. The reference demo SDK packages register, transfer, and withdraw artifacts, but it does not implement or package the spender witness flows. QuietBook adds current `set_spender` and `spender_transfer` witness and payload adapters; `revoke_spender` does not require a new auction proof path for the P0 settlement flow.
7. Noir `1.0.0-beta.9` and Barretenberg `0.87.0` are the upstream artifact toolchain. They are not assumed to be globally installed; reproducible project-local scripts will pin them.
8. The reference demo revision predates a protocol hardening change: its ECDH helper returns only the shared point's x-coordinate, while the pinned OpenZeppelin revision derives `Poseidon2(13, S.x, S.y)`. QuietBook uses the current two-coordinate derivation and has a proof test that detects future drift.

## Current gate result

The local integration gate passes. Contract tests prove controller identity, live delegation reads, and controller-driven spender transfer against the upstream contract. QuietBook builds current `set_spender` and `spender_transfer` witnesses, encodes their Soroban payloads, and generates and locally verifies 14,592-byte Keccak-transcript UltraHonk proofs for both pinned circuits.

The fixed `N=3` Max-Bid circuit binds the round domain, ordered live allowance commitments, active slots, public reserve, deterministic winner index, and the exact confidential settlement payment commitment. Its 14,592-byte real proof verifies both locally and through the dedicated Soroban verifier contract.

The market constructs those public inputs from trusted round and confidential-token state, calls the verifier cross-contract, invokes controller settlement, and releases the public RWA lot atomically. Tests cover successful settlement and rollback on invalid proof, invalid winner, revoked delegation, controller mismatch, and replay. All three contracts build for `wasm32v1-none`.

The remaining P0 evidence item is to reproduce the full flow on Stellar Testnet and archive transaction and event references before UI work or public claims.
