#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Bytes, BytesN, Env};
use ultrahonk_soroban_verifier::UltraHonkVerifier;

#[contracttype]
enum DataKey {
    VerificationKey,
    VerificationKeyHash,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MaxBidVerifierError {
    InvalidVerificationKey = 4200,
}

#[contract]
pub struct MaxBidVerifier;

#[contractimpl]
impl MaxBidVerifier {
    pub fn __constructor(e: Env, verification_key: Bytes) {
        if UltraHonkVerifier::new(&e, &verification_key).is_err() {
            soroban_sdk::panic_with_error!(&e, MaxBidVerifierError::InvalidVerificationKey);
        }
        let hash = BytesN::from_array(&e, &e.crypto().sha256(&verification_key).to_array());
        e.storage()
            .instance()
            .set(&DataKey::VerificationKey, &verification_key);
        e.storage()
            .instance()
            .set(&DataKey::VerificationKeyHash, &hash);
    }

    pub fn verify(e: Env, public_inputs: Bytes, proof: Bytes) -> bool {
        let key: Bytes = e
            .storage()
            .instance()
            .get(&DataKey::VerificationKey)
            .unwrap();
        let verifier = UltraHonkVerifier::new(&e, &key).unwrap_or_else(|_| {
            soroban_sdk::panic_with_error!(&e, MaxBidVerifierError::InvalidVerificationKey)
        });
        verifier.verify(&e, &proof, &public_inputs).is_ok()
    }

    pub fn verification_key_hash(e: Env) -> BytesN<32> {
        e.storage()
            .instance()
            .get(&DataKey::VerificationKeyHash)
            .unwrap()
    }
}

#[cfg(test)]
mod test;
