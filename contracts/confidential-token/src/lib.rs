#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};
use stellar_tokens::confidential::{
    storage, ConfidentialAccount, ConfidentialToken, NoHooks, SpenderDelegation,
};

#[contract]
pub struct QuietBookConfidentialToken;

#[contractimpl]
impl QuietBookConfidentialToken {
    pub fn __constructor(e: &Env, underlying_asset: Address, verifier: Address, auditor: Address) {
        storage::set_underlying_asset(e, &underlying_asset);
        storage::set_verifier(e, &verifier);
        storage::set_auditor(e, &auditor);
        storage::set_address_as_field_element(e);
    }
}

#[contractimpl(contracttrait)]
impl ConfidentialToken for QuietBookConfidentialToken {
    type Hooks = NoHooks;
}
