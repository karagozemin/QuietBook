#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env};
use stellar_tokens::confidential::verifier::{storage, CircuitType, ConfidentialVerifier};

#[contracttype]
enum DataKey {
    Manager,
}

#[contract]
pub struct QuietBookConfidentialVerifier;

#[contractimpl]
impl QuietBookConfidentialVerifier {
    pub fn __constructor(e: Env, manager: Address) {
        e.storage().instance().set(&DataKey::Manager, &manager);
    }

    pub fn manager(e: Env) -> Address {
        e.storage().instance().get(&DataKey::Manager).unwrap()
    }
}

#[contractimpl(contracttrait)]
impl ConfidentialVerifier for QuietBookConfidentialVerifier {
    fn register_verification_key(
        e: &Env,
        circuit_type: CircuitType,
        verification_key: Bytes,
        operator: Address,
    ) {
        require_manager(e, &operator);
        storage::register_verification_key(e, circuit_type, &verification_key);
    }

    fn update_verification_key(
        e: &Env,
        circuit_type: CircuitType,
        new_verification_key: Bytes,
        operator: Address,
    ) {
        require_manager(e, &operator);
        storage::update_verification_key(e, circuit_type, &new_verification_key);
    }
}

fn require_manager(e: &Env, operator: &Address) {
    let manager: Address = e.storage().instance().get(&DataKey::Manager).unwrap();
    if *operator != manager {
        panic!("operator is not verifier manager");
    }
    operator.require_auth();
}
