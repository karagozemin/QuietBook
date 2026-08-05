# QuietBook evidence index

All evidence in this directory is for the unaudited Stellar Testnet prototype. No file contains bid values, allowance openings, confidential account secrets, or auditor secrets.

## Deployment

- [`testnet/deployment.json`](testnet/deployment.json) pins role addresses, contract IDs, Wasm hashes, upstream revisions, six confidential verification keys, the Max-Bid verification key, and the auditor public key.
- Superseded deployments remain listed with their replacement reason; they are not silently removed from the record.

## End-to-end run

| Claim | Evidence |
| --- | --- |
| Current account-bound Register proof verifies on-chain | [`testnet/register-smoke.json`](testnet/register-smoke.json) |
| A round-bound controller registers through market contract authorization | [`testnet/controller-smoke.json`](testnet/controller-smoke.json) |
| Three eligible confidential bidders register; the unauthorized account is rejected | [`testnet/round-setup.json`](testnet/round-setup.json) |
| Market statement matches the Max-Bid proof statement byte-for-byte | [`testnet/settlement.json`](testnet/settlement.json) |
| Confidential winner payment and public RWA delivery settle atomically | [`testnet/settlement.json`](testnet/settlement.json) |

The final settlement transaction is [`3a47b09e...9246d`](https://stellar.expert/explorer/testnet/tx/3a47b09ea1def84f1bef4bb71a00fab2080cfb5e5697a84d86c549a97f89246d). Independent reads after confirmation returned `Settled`, the expected public winner, a registered controller, the stored Max-Bid proof hash, and the full RWA lot in the winner's balance.
