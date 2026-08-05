#![no_std]

use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env};

#[contracttype]
enum DataKey {
    Admin,
    Authorized(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EligibilityChanged {
    #[topic]
    pub account: Address,
    pub authorized: bool,
}

#[contract]
pub struct EligibilityPolicy;

#[contractimpl]
impl EligibilityPolicy {
    pub fn __constructor(e: Env, admin: Address) {
        e.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn set_authorized(e: Env, account: Address, authorized: bool) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        e.storage()
            .persistent()
            .set(&DataKey::Authorized(account.clone()), &authorized);
        EligibilityChanged {
            account,
            authorized,
        }
        .publish(&e);
    }

    pub fn is_authorized(e: Env, account: Address, _token: Address) -> bool {
        e.storage()
            .persistent()
            .get(&DataKey::Authorized(account))
            .unwrap_or(false)
    }

    pub fn admin(e: Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }
}

#[cfg(test)]
mod test;
