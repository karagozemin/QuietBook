#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Bytes, Env};
use stellar_tokens::confidential::ConfidentialTokenClient;

#[contracttype]
enum DataKey {
    Market,
    ConfidentialToken,
    IssuerRecipient,
    SettlementDeadline,
    Registered,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ControllerError {
    AlreadyRegistered = 4100,
    NotRegistered = 4101,
    SettlementDeadlinePassed = 4102,
}

#[contract]
pub struct RoundController;

#[contractimpl]
impl RoundController {
    pub fn __constructor(
        e: Env,
        market: Address,
        confidential_token: Address,
        issuer_recipient: Address,
        settlement_deadline_ledger: u32,
    ) {
        e.storage().instance().set(&DataKey::Market, &market);
        e.storage()
            .instance()
            .set(&DataKey::ConfidentialToken, &confidential_token);
        e.storage()
            .instance()
            .set(&DataKey::IssuerRecipient, &issuer_recipient);
        e.storage()
            .instance()
            .set(&DataKey::SettlementDeadline, &settlement_deadline_ledger);
        e.storage().instance().set(&DataKey::Registered, &false);
    }

    pub fn register(e: Env, auditor_id: u32, register_data: Bytes) {
        market(&e).require_auth();
        if is_registered(&e) {
            soroban_sdk::panic_with_error!(&e, ControllerError::AlreadyRegistered);
        }
        ConfidentialTokenClient::new(&e, &token(&e)).register(
            &e.current_contract_address(),
            &auditor_id,
            &register_data,
        );
        e.storage().instance().set(&DataKey::Registered, &true);
    }

    pub fn settle(e: Env, from: Address, spender_transfer_data: Bytes) {
        market(&e).require_auth();
        if !is_registered(&e) {
            soroban_sdk::panic_with_error!(&e, ControllerError::NotRegistered);
        }
        let deadline: u32 = e
            .storage()
            .instance()
            .get(&DataKey::SettlementDeadline)
            .unwrap();
        if e.ledger().sequence() > deadline {
            soroban_sdk::panic_with_error!(&e, ControllerError::SettlementDeadlinePassed);
        }
        ConfidentialTokenClient::new(&e, &token(&e)).confidential_transfer_from(
            &e.current_contract_address(),
            &from,
            &issuer(&e),
            &spender_transfer_data,
        );
    }

    pub fn configuration(e: Env) -> (Address, Address, Address, u32, bool) {
        (
            market(&e),
            token(&e),
            issuer(&e),
            e.storage()
                .instance()
                .get(&DataKey::SettlementDeadline)
                .unwrap(),
            is_registered(&e),
        )
    }
}

fn market(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Market).unwrap()
}

fn token(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::ConfidentialToken)
        .unwrap()
}

fn issuer(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::IssuerRecipient)
        .unwrap()
}

fn is_registered(e: &Env) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::Registered)
        .unwrap_or(false)
}

#[cfg(test)]
mod test;
