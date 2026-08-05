#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};
use stellar_tokens::confidential::auditor::{storage, ConfidentialAuditor};

#[contracttype]
enum DataKey {
    Manager,
}

#[contract]
pub struct QuietBookConfidentialAuditor;

#[contractimpl]
impl QuietBookConfidentialAuditor {
    pub fn __constructor(e: Env, manager: Address) {
        e.storage().instance().set(&DataKey::Manager, &manager);
    }

    pub fn manager(e: Env) -> Address {
        e.storage().instance().get(&DataKey::Manager).unwrap()
    }
}

#[contractimpl(contracttrait)]
impl ConfidentialAuditor for QuietBookConfidentialAuditor {
    fn register_key(e: &Env, auditor_id: u32, point: BytesN<64>, operator: Address) {
        require_manager(e, &operator);
        storage::register_key(e, auditor_id, &point);
    }

    fn rotate_key(e: &Env, auditor_id: u32, new_point: BytesN<64>, operator: Address) {
        require_manager(e, &operator);
        storage::rotate_key(e, auditor_id, &new_point);
    }
}

fn require_manager(e: &Env, operator: &Address) {
    let manager: Address = e.storage().instance().get(&DataKey::Manager).unwrap();
    if *operator != manager {
        panic!("operator is not auditor manager");
    }
    operator.require_auth();
}
