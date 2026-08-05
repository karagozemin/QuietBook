#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, MuxedAddress, String};
use stellar_tokens::fungible::{Base, FungibleToken};

#[contracttype]
enum DataKey {
    Admin,
}

#[contract]
pub struct DemoRwaToken;

#[contractimpl]
impl DemoRwaToken {
    pub fn __constructor(e: Env, admin: Address, name: String, symbol: String) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        Base::set_metadata(&e, 7, name, symbol);
    }

    pub fn mint(e: Env, to: Address, amount: i128) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        Base::mint(&e, &to, amount);
    }

    pub fn admin(e: Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for DemoRwaToken {
    type ContractType = Base;
}

#[cfg(test)]
mod test;
