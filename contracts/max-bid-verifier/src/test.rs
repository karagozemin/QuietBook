extern crate std;

use super::*;
use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

const VK: &[u8] = include_bytes!("../../../packages/sdk/circuits/max_bid.vk.bin");
const PROOF: &[u8] = include_bytes!("../../../packages/sdk/circuits/max_bid.proof.bin");
const PUBLIC_INPUTS: &[u8] =
    include_bytes!("../../../packages/sdk/circuits/max_bid.public-inputs.bin");

#[contract]
struct VerifierCaller;

#[contractimpl]
impl VerifierCaller {
    pub fn verify(e: Env, verifier: Address, public_inputs: Bytes, proof: Bytes) -> bool {
        MaxBidVerifierClient::new(&e, &verifier).verify(&public_inputs, &proof)
    }
}

#[test]
fn verifies_real_max_bid_proof_cross_contract() {
    let e = Env::default();
    e.cost_estimate().budget().reset_unlimited();
    let verifier_address = e.register(MaxBidVerifier, (Bytes::from_slice(&e, VK),));
    let caller_address = e.register(VerifierCaller, ());
    let caller = VerifierCallerClient::new(&e, &caller_address);

    assert!(caller.verify(
        &verifier_address,
        &Bytes::from_slice(&e, PUBLIC_INPUTS),
        &Bytes::from_slice(&e, PROOF),
    ));
}

#[test]
fn rejects_mutated_max_bid_proof() {
    let e = Env::default();
    e.cost_estimate().budget().reset_unlimited();
    let verifier_address = e.register(MaxBidVerifier, (Bytes::from_slice(&e, VK),));
    let verifier = MaxBidVerifierClient::new(&e, &verifier_address);
    let mut proof = Bytes::from_slice(&e, PROOF);
    proof.set(100, proof.get(100).unwrap() ^ 1);

    assert!(!verifier.verify(&Bytes::from_slice(&e, PUBLIC_INPUTS), &proof));
}
