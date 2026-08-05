extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, xdr::ToXdr, Address, Bytes, BytesN, Env,
};
use stellar_tokens::confidential::{
    auditor::{storage as auditor_storage, ConfidentialAuditor},
    storage as token_storage,
    verifier::{CircuitType, ConfidentialVerifier},
    ConfidentialAccount, ConfidentialToken, ConfidentialTokenClient, NoHooks, RegisterData,
    RegisterPayload, SetSpenderData, SetSpenderPayload, SpenderDelegation, SpenderTransferData,
    SpenderTransferPayload,
};

const GRUMPKIN_G_BYTES: [u8; 64] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 2, 0xcf, 0x13, 0x5e, 0x75, 0x06, 0xa4, 0x5d, 0x63, 0x2d, 0x27, 0x0d, 0x45,
    0xf1, 0x18, 0x12, 0x94, 0x83, 0x3f, 0xc4, 0x8d, 0x82, 0x3f, 0x27, 0x2c,
];

#[contract]
struct TokenContract;

#[contractimpl]
impl TokenContract {
    pub fn __constructor(e: &Env, token: Address, verifier: Address, auditor: Address) {
        token_storage::set_underlying_asset(e, &token);
        token_storage::set_verifier(e, &verifier);
        token_storage::set_auditor(e, &auditor);
        token_storage::set_address_as_field_element(e);
    }
}

#[contractimpl(contracttrait)]
impl ConfidentialToken for TokenContract {
    type Hooks = NoHooks;
}

#[contract]
struct MockVerifier;

#[contractimpl(contracttrait)]
impl ConfidentialVerifier for MockVerifier {
    fn register_verification_key(_e: &Env, _kind: CircuitType, _key: Bytes, _operator: Address) {}
    fn update_verification_key(_e: &Env, _kind: CircuitType, _key: Bytes, _operator: Address) {}
    fn verify_proof(_e: &Env, _kind: CircuitType, _inputs: Bytes, _proof: Bytes) -> bool {
        true
    }
}

#[contract]
struct MockAuditor;

#[contractimpl(contracttrait)]
impl ConfidentialAuditor for MockAuditor {
    fn register_key(e: &Env, auditor_id: u32, point: BytesN<64>, _operator: Address) {
        auditor_storage::register_key(e, auditor_id, &point);
    }
    fn rotate_key(e: &Env, auditor_id: u32, point: BytesN<64>, _operator: Address) {
        auditor_storage::rotate_key(e, auditor_id, &point);
    }
}

#[contract]
struct MarketInvoker;

#[contractimpl]
impl MarketInvoker {
    pub fn register_controller(e: Env, controller: Address, auditor_id: u32, register_data: Bytes) {
        RoundControllerClient::new(&e, &controller).register(&auditor_id, &register_data);
    }

    pub fn settle(e: Env, controller: Address, from: Address, spender_transfer_data: Bytes) {
        RoundControllerClient::new(&e, &controller).settle(&from, &spender_transfer_data);
    }
}

fn point(e: &Env) -> BytesN<64> {
    BytesN::from_array(e, &GRUMPKIN_G_BYTES)
}

fn field(e: &Env, byte: u8) -> BytesN<32> {
    let mut value = [byte; 32];
    value[0] = 0;
    BytesN::from_array(e, &value)
}

fn register_data(e: &Env) -> Bytes {
    RegisterData {
        payload: RegisterPayload {
            y: point(e),
            pvk: point(e),
        },
        proof: Bytes::new(e),
    }
    .to_xdr(e)
}

fn set_spender_data(e: &Env) -> Bytes {
    SetSpenderData {
        payload: SetSpenderPayload {
            c_spend_new: point(e),
            c_a: point(e),
            escrowed_dvk: point(e),
            b_tilde: field(e, 0x21),
            a_tilde: field(e, 0x22),
            r_e_point: point(e),
            sigma: field(e, 0x23),
            sigma_a: field(e, 0x24),
            v_tilde_aud_s: field(e, 0x25),
            b_tilde_aud_s: field(e, 0x26),
        },
        proof: Bytes::new(e),
    }
    .to_xdr(e)
}

fn spender_transfer_data(e: &Env) -> Bytes {
    SpenderTransferData {
        payload: SpenderTransferPayload {
            c_a_new: point(e),
            c_transfer: point(e),
            r_e_point: point(e),
            v_tilde: field(e, 0x31),
            a_tilde_new: field(e, 0x32),
            sigma_a_new: field(e, 0x33),
            v_tilde_aud_r: field(e, 0x34),
            r_tilde_aud_r: field(e, 0x35),
            v_tilde_aud_s: field(e, 0x36),
            a_tilde_aud_s: field(e, 0x37),
        },
        proof: Bytes::new(e),
    }
    .to_xdr(e)
}

#[test]
fn controller_registers_reads_delegation_and_spends_as_contract_identity() {
    let e = Env::default();
    let market = e.register(MarketInvoker, ());
    let market_client = MarketInvokerClient::new(&e, &market);
    let issuer = Address::generate(&e);
    let investor = Address::generate(&e);
    let verifier = e.register(MockVerifier, ());
    let auditor = e.register(MockAuditor, ());
    let sac = e.register_stellar_asset_contract_v2(Address::generate(&e));
    let token_address = e.register(TokenContract, (sac.address(), verifier, auditor.clone()));
    let token = ConfidentialTokenClient::new(&e, &token_address);

    stellar_tokens::confidential::auditor::ConfidentialAuditorClient::new(&e, &auditor)
        .register_key(&1, &point(&e), &Address::generate(&e));
    e.mock_all_auths();
    token.register(&investor, &1, &register_data(&e));
    token.register(&issuer, &1, &register_data(&e));

    let controller_address = e.register(
        RoundController,
        (
            market.clone(),
            token_address.clone(),
            issuer.clone(),
            500u32,
        ),
    );
    e.set_auths(&[]);
    market_client.register_controller(&controller_address, &1, &register_data(&e));

    e.mock_all_auths();
    token.set_spender(&investor, &controller_address, &500, &set_spender_data(&e));

    let before = token.get_spender_delegation(&investor, &controller_address);
    assert_eq!(before.live_until_ledger, 500);
    assert_eq!(before.allowance_commitment, point(&e));

    e.set_auths(&[]);
    market_client.settle(&controller_address, &investor, &spender_transfer_data(&e));

    let after = token.get_spender_delegation(&investor, &controller_address);
    assert_eq!(after.allowance_salt, field(&e, 0x33));
    assert_ne!(
        token
            .confidential_balance(&issuer)
            .receiving_commitment
            .to_array(),
        [0; 64]
    );
}
