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
5. The OpenZeppelin verifier already demonstrates cross-contract UltraHonk verification. QuietBook still needs a dedicated verifier because the upstream `CircuitType` enum has no Max-Bid variant.
6. The reference demo SDK packages register, transfer, and withdraw artifacts, but it does not currently implement or package the spender witness flows. QuietBook must add `set_spender`, `spender_transfer`, and `revoke_spender` adapters before the real-proof integration gate can pass.
7. Noir `1.0.0-beta.9` and Barretenberg `0.87.0` are the upstream artifact toolchain. They are not assumed to be globally installed; reproducible project-local scripts will pin them.

## Current gate result

The contract API and authorization model are viable. Local contract tests prove controller identity, live delegation reads, and controller-driven spender transfer using the upstream contract with a mock verifier. Real witness/proof generation and the dedicated Max-Bid verifier remain open gate items and must be completed before UI work.

