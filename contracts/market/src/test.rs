extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    xdr::ToXdr,
    Address, Bytes, BytesN, Env,
};
use stellar_tokens::confidential::{
    SpenderDelegation, SpenderTransferData, SpenderTransferPayload,
};

#[contract]
struct MockPolicy;

#[contractimpl]
impl MockPolicy {
    pub fn set(e: Env, account: Address, allowed: bool) {
        e.storage().persistent().set(&account, &allowed);
    }

    pub fn is_authorized(e: Env, account: Address, _token: Address) -> bool {
        e.storage().persistent().get(&account).unwrap_or(false)
    }
}

#[contract]
struct MockConfidentialToken;

#[contractimpl]
impl MockConfidentialToken {
    pub fn deposit(e: Env, from: Address, _to: Address, amount: i128) {
        from.require_auth();
        e.storage().instance().set(&10u32, &amount);
    }

    pub fn merge(e: Env, account: Address) {
        account.require_auth();
        e.storage().instance().set(&11u32, &true);
    }

    pub fn set_spender(
        e: Env,
        account: Address,
        spender: Address,
        live_until_ledger: u32,
        _data: Bytes,
    ) {
        account.require_auth();
        Self::set_delegation(e, account, spender, live_until_ledger);
    }

    pub fn deposited(e: Env) -> i128 {
        e.storage().instance().get(&10u32).unwrap_or(0)
    }

    pub fn merged(e: Env) -> bool {
        e.storage().instance().get(&11u32).unwrap_or(false)
    }

    pub fn set_delegation(e: Env, owner: Address, spender: Address, live_until_ledger: u32) {
        e.storage().persistent().set(
            &(owner, spender),
            &SpenderDelegation {
                allowance_commitment: BytesN::from_array(&e, &[1; 64]),
                a_tilde: BytesN::from_array(&e, &[2; 32]),
                escrowed_dvk: BytesN::from_array(&e, &[3; 64]),
                allowance_salt: BytesN::from_array(&e, &[4; 32]),
                live_until_ledger,
            },
        );
    }

    pub fn is_spender(e: Env, account: Address, spender: Address) -> bool {
        e.storage()
            .persistent()
            .get::<_, SpenderDelegation>(&(account, spender))
            .map(|d| e.ledger().sequence() <= d.live_until_ledger)
            .unwrap_or(false)
    }

    pub fn get_spender_delegation(e: Env, account: Address, spender: Address) -> SpenderDelegation {
        e.storage().persistent().get(&(account, spender)).unwrap()
    }

    pub fn revoke_delegation(e: Env, owner: Address, spender: Address) {
        e.storage().persistent().remove(&(owner, spender));
    }

    pub fn revoke_spender(e: Env, owner: Address, spender: Address, _data: soroban_sdk::Bytes) {
        owner.require_auth();
        e.storage().persistent().remove(&(owner, spender));
    }
}

#[contract]
struct MockController;

#[contractimpl]
impl MockController {
    pub fn __constructor(e: Env, market: Address, token: Address, issuer: Address, deadline: u32) {
        e.storage().instance().set(&0u32, &market);
        e.storage().instance().set(&1u32, &token);
        e.storage().instance().set(&2u32, &issuer);
        e.storage().instance().set(&3u32, &deadline);
        e.storage().instance().set(&7u32, &false);
    }

    pub fn configuration(e: Env) -> (Address, Address, Address, u32, bool) {
        (
            e.storage().instance().get(&0u32).unwrap(),
            e.storage().instance().get(&1u32).unwrap(),
            e.storage().instance().get(&2u32).unwrap(),
            e.storage().instance().get(&3u32).unwrap(),
            e.storage().instance().get(&7u32).unwrap_or(false),
        )
    }

    pub fn register(e: Env, _auditor_id: u32, register_data: Bytes) {
        e.storage().instance().set(&7u32, &true);
        e.storage().instance().set(&8u32, &register_data);
    }

    pub fn settle(e: Env, from: Address, spender_transfer_data: Bytes) {
        e.storage().instance().set(&4u32, &from);
        e.storage().instance().set(&5u32, &spender_transfer_data);
        let count = e.storage().instance().get::<_, u32>(&6u32).unwrap_or(0);
        e.storage().instance().set(&6u32, &(count + 1));
    }

    pub fn settlement_count(e: Env) -> u32 {
        e.storage().instance().get(&6u32).unwrap_or(0)
    }
}

#[contract]
struct MockMaxBidVerifier;

#[contractimpl]
impl MockMaxBidVerifier {
    pub fn set_valid(e: Env, valid: bool) {
        e.storage().instance().set(&0u32, &valid);
    }

    pub fn verify(e: Env, public_inputs: Bytes, _proof: Bytes) -> bool {
        e.storage().instance().set(&1u32, &public_inputs);
        e.storage().instance().get(&0u32).unwrap_or(false)
    }
}

struct Harness<'a> {
    e: Env,
    market: QuietBookMarketClient<'a>,
    policy: MockPolicyClient<'a>,
    confidential: MockConfidentialTokenClient<'a>,
    controller: MockControllerClient<'a>,
    verifier: MockMaxBidVerifierClient<'a>,
    issuer: Address,
    investor: Address,
    rwa: soroban_sdk::token::StellarAssetClient<'a>,
    rwa_address: Address,
}

fn setup<'a>() -> Harness<'a> {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_sequence_number(100);

    let issuer = Address::generate(&e);
    let investor = Address::generate(&e);
    let policy_address = e.register(MockPolicy, ());
    let confidential_address = e.register(MockConfidentialToken, ());
    let market_address = e.register(QuietBookMarket, ());
    let controller_address = e.register(
        MockController,
        (
            market_address.clone(),
            confidential_address.clone(),
            issuer.clone(),
            300u32,
        ),
    );
    let verifier_address = e.register(MockMaxBidVerifier, ());
    let rwa = e.register_stellar_asset_contract_v2(issuer.clone());
    let rwa_address = rwa.address();

    Harness {
        market: QuietBookMarketClient::new(&e, &market_address),
        policy: MockPolicyClient::new(&e, &policy_address),
        confidential: MockConfidentialTokenClient::new(&e, &confidential_address),
        controller: MockControllerClient::new(&e, &controller_address),
        verifier: MockMaxBidVerifierClient::new(&e, &verifier_address),
        e: e.clone(),
        issuer,
        investor,
        rwa: soroban_sdk::token::StellarAssetClient::new(&e, &rwa_address),
        rwa_address,
    }
}

fn config(h: &Harness<'_>) -> RoundConfig {
    RoundConfig {
        issuer: h.issuer.clone(),
        rwa_token: h.rwa_address.clone(),
        rwa_lot: 1_000,
        confidential_token: h.confidential.address.clone(),
        controller: h.controller.address.clone(),
        eligibility_policy: h.policy.address.clone(),
        max_bid_verifier: h.verifier.address.clone(),
        auditor_id: 1,
        reserve_public: 9_000,
        bid_deadline_ledger: 200,
        settlement_deadline_ledger: 300,
    }
}

fn field(e: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(e, &[byte; 32])
}

fn point(e: &Env, byte: u8) -> BytesN<64> {
    BytesN::from_array(e, &[byte; 64])
}

fn spender_transfer_data(e: &Env) -> Bytes {
    SpenderTransferData {
        payload: SpenderTransferPayload {
            c_a_new: point(e, 1),
            c_transfer: point(e, 2),
            r_e_point: point(e, 3),
            v_tilde: field(e, 4),
            a_tilde_new: field(e, 5),
            sigma_a_new: field(e, 6),
            v_tilde_aud_r: field(e, 7),
            r_tilde_aud_r: field(e, 8),
            v_tilde_aud_s: field(e, 9),
            a_tilde_aud_s: field(e, 10),
        },
        proof: Bytes::new(e),
    }
    .to_xdr(e)
}

fn registered_closed_round(h: &Harness<'_>) -> BytesN<32> {
    let id = funded_open_round(h);
    h.policy.set(&h.investor, &true);
    h.confidential
        .set_delegation(&h.investor, &h.controller.address, &300);
    h.market.register_bid(&id, &h.investor);
    h.e.ledger().set_sequence_number(201);
    h.market.close_round(&id);
    id
}

fn funded_open_round(h: &Harness<'_>) -> BytesN<32> {
    h.rwa.mint(&h.issuer, &1_000);
    let id = h.market.create_round(&config(h));
    h.market.fund_round(&id);
    h.market.register_controller(&id, &1, &Bytes::new(&h.e));
    h.market.open_round(&id);
    id
}

#[test]
fn create_and_open_round_preserves_the_full_opening_invariants() {
    let h = setup();
    h.rwa.mint(&h.issuer, &1_000);

    let id = h
        .market
        .create_and_open_round(&config(&h), &1, &Bytes::new(&h.e));
    let auths = h.e.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, h.issuer);
    let round = h.market.get_round(&id);

    assert_eq!(round.status, RoundStatus::Open);
    assert!(round.rwa_escrowed);
    assert_eq!(h.rwa.balance(&h.market.address), 1_000);
    assert!(h.controller.configuration().4);
}

#[test]
fn round_requires_escrow_then_registers_only_live_eligible_bidder() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);
    h.confidential
        .set_delegation(&h.investor, &h.controller.address, &300);

    h.market.register_bid(&id, &h.investor);

    let round = h.market.get_round(&id);
    assert_eq!(round.status, RoundStatus::Open);
    assert_eq!(round.bidder_count, 1);
    assert_eq!(
        h.market.get_bidders(&id),
        soroban_sdk::vec![&h.e, h.investor.clone()]
    );
    assert!(h.market.get_bid(&id, &h.investor).is_some());
}

#[test]
fn submit_bid_atomically_funds_delegates_and_registers_with_one_authorization() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);

    h.market
        .submit_bid(&id, &h.investor, &20, &Bytes::new(&h.e));

    let auths = h.e.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, h.investor);
    assert_eq!(h.confidential.deposited(), 20);
    assert!(h.confidential.merged());
    assert!(h
        .confidential
        .is_spender(&h.investor, &h.controller.address));
    assert_eq!(h.market.get_round(&id).bidder_count, 1);
    assert!(h.market.get_bid(&id, &h.investor).unwrap().active);
}

#[test]
fn expired_atomic_bid_fails_before_funding_or_delegation() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);
    h.e.ledger().set_sequence_number(201);

    assert!(h
        .market
        .try_submit_bid(&id, &h.investor, &20, &Bytes::new(&h.e))
        .is_err());
    assert_eq!(h.confidential.deposited(), 0);
    assert!(!h.confidential.merged());
    assert!(!h
        .confidential
        .is_spender(&h.investor, &h.controller.address));
    assert_eq!(h.market.get_round(&id).bidder_count, 0);
}

#[test]
fn close_freezes_ordered_participant_hash() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);
    h.confidential
        .set_delegation(&h.investor, &h.controller.address, &300);
    h.market.register_bid(&id, &h.investor);
    h.e.ledger().set_sequence_number(201);

    let hash = h.market.close_round(&id);
    let round = h.market.get_round(&id);
    assert_eq!(round.status, RoundStatus::Closed);
    assert_eq!(round.participant_set_hash, Some(hash));
}

#[test]
fn bidder_withdrawal_revokes_delegation_and_removes_active_registration() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);
    h.confidential
        .set_delegation(&h.investor, &h.controller.address, &300);
    h.market.register_bid(&id, &h.investor);

    h.market
        .withdraw_bid(&id, &h.investor, &soroban_sdk::Bytes::new(&h.e));

    assert!(!h
        .confidential
        .is_spender(&h.investor, &h.controller.address));
    assert!(!h.market.get_bid(&id, &h.investor).unwrap().active);
    assert_eq!(h.market.get_round(&id).bidder_count, 0);
    assert!(h
        .market
        .try_withdraw_bid(&id, &h.investor, &soroban_sdk::Bytes::new(&h.e))
        .is_err());
}

#[test]
fn close_excludes_a_bidder_that_revoked_outside_the_market() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);
    h.confidential
        .set_delegation(&h.investor, &h.controller.address, &300);
    h.market.register_bid(&id, &h.investor);
    h.confidential
        .revoke_delegation(&h.investor, &h.controller.address);

    h.e.ledger().set_sequence_number(201);
    h.market.close_round(&id);

    assert_eq!(h.market.get_round(&id).bidder_count, 0);
    assert_eq!(h.market.get_bidders(&id).len(), 0);
    assert!(!h.market.get_bid(&id, &h.investor).unwrap().active);
}

#[test]
fn bid_registration_and_withdrawal_fail_after_deadline() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);
    h.confidential
        .set_delegation(&h.investor, &h.controller.address, &300);
    h.market.register_bid(&id, &h.investor);
    h.e.ledger().set_sequence_number(201);

    assert!(h
        .market
        .try_withdraw_bid(&id, &h.investor, &soroban_sdk::Bytes::new(&h.e))
        .is_err());
    assert!(h
        .confidential
        .is_spender(&h.investor, &h.controller.address));

    let late_bidder = Address::generate(&h.e);
    h.policy.set(&late_bidder, &true);
    h.confidential
        .set_delegation(&late_bidder, &h.controller.address, &300);
    assert!(h.market.try_register_bid(&id, &late_bidder).is_err());
    assert!(h.market.get_bid(&id, &late_bidder).is_none());
}

#[test]
fn unauthorized_bid_is_rejected_without_registration() {
    let h = setup();
    let id = funded_open_round(&h);
    h.confidential
        .set_delegation(&h.investor, &h.controller.address, &300);

    let result = h.market.try_register_bid(&id, &h.investor);
    assert!(result.is_err());
    assert_eq!(h.market.get_round(&id).bidder_count, 0);
}

#[test]
fn missing_delegation_is_rejected() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);

    let result = h.market.try_register_bid(&id, &h.investor);
    assert!(result.is_err());
    assert_eq!(h.market.get_round(&id).bidder_count, 0);
}

#[test]
fn failed_round_returns_rwa_exactly_once() {
    let h = setup();
    let id = funded_open_round(&h);
    h.e.ledger().set_sequence_number(201);
    h.market.close_round(&id);
    h.market.mark_no_sale(&id);
    h.market.reclaim_rwa(&id);

    assert_eq!(h.rwa.balance(&h.issuer), 1_000);
    let round = h.market.get_round(&id);
    assert!(round.rwa_reclaimed);
    assert_eq!(round.status, RoundStatus::Cancelled);
    assert!(h.market.try_reclaim_rwa(&id).is_err());
}

#[test]
fn fourth_bidder_is_rejected_at_fixed_proof_capacity() {
    let h = setup();
    let id = funded_open_round(&h);

    for _ in 0..3 {
        let bidder = Address::generate(&h.e);
        h.policy.set(&bidder, &true);
        h.confidential
            .set_delegation(&bidder, &h.controller.address, &300);
        h.market.register_bid(&id, &bidder);
    }

    let fourth = Address::generate(&h.e);
    h.policy.set(&fourth, &true);
    h.confidential
        .set_delegation(&fourth, &h.controller.address, &300);
    assert!(h.market.try_register_bid(&id, &fourth).is_err());
    assert_eq!(h.market.get_round(&id).bidder_count, 3);
}

#[test]
fn finalize_atomically_settles_payment_and_delivers_rwa() {
    let h = setup();
    let id = registered_closed_round(&h);
    let transfer_data = spender_transfer_data(&h.e);
    h.verifier.set_valid(&true);

    h.market
        .finalize(&id, &0, &Bytes::from_slice(&h.e, &[42]), &transfer_data);

    let round = h.market.get_round(&id);
    assert_eq!(round.status, RoundStatus::Settled);
    assert_eq!(round.winner, Some(h.investor.clone()));
    assert!(round.proof_hash.is_some());
    assert_eq!(h.controller.settlement_count(), 1);
    assert_eq!(h.rwa.balance(&h.investor), 1_000);
    assert_eq!(h.rwa.balance(&h.market.address), 0);
}

#[test]
fn invalid_proof_rolls_back_without_payment_or_rwa_delivery() {
    let h = setup();
    let id = registered_closed_round(&h);

    assert!(h
        .market
        .try_finalize(
            &id,
            &0,
            &Bytes::from_slice(&h.e, &[42]),
            &spender_transfer_data(&h.e),
        )
        .is_err());
    assert_eq!(h.market.get_round(&id).status, RoundStatus::Closed);
    assert_eq!(h.controller.settlement_count(), 0);
    assert_eq!(h.rwa.balance(&h.investor), 0);
    assert_eq!(h.rwa.balance(&h.market.address), 1_000);
}

#[test]
fn settled_round_cannot_be_finalized_twice() {
    let h = setup();
    let id = registered_closed_round(&h);
    let proof = Bytes::from_slice(&h.e, &[42]);
    let transfer_data = spender_transfer_data(&h.e);
    h.verifier.set_valid(&true);
    h.market.finalize(&id, &0, &proof, &transfer_data);

    assert!(h
        .market
        .try_finalize(&id, &0, &proof, &transfer_data)
        .is_err());
    assert_eq!(h.controller.settlement_count(), 1);
}

#[test]
fn invalid_winner_and_revoked_delegation_are_rejected() {
    let h = setup();
    let id = registered_closed_round(&h);
    let proof = Bytes::from_slice(&h.e, &[42]);
    let transfer_data = spender_transfer_data(&h.e);
    h.verifier.set_valid(&true);

    assert!(h
        .market
        .try_finalize(&id, &1, &proof, &transfer_data)
        .is_err());
    h.confidential
        .revoke_delegation(&h.investor, &h.controller.address);
    assert!(h
        .market
        .try_finalize(&id, &0, &proof, &transfer_data)
        .is_err());
    assert_eq!(h.controller.settlement_count(), 0);
    assert_eq!(h.rwa.balance(&h.market.address), 1_000);
}

#[test]
fn controller_configuration_mismatch_blocks_opening() {
    let h = setup();
    h.rwa.mint(&h.issuer, &1_000);
    let mut bad_config = config(&h);
    bad_config.settlement_deadline_ledger = 301;
    let id = h.market.create_round(&bad_config);
    h.market.fund_round(&id);

    assert!(h
        .market
        .try_register_controller(&id, &1, &Bytes::new(&h.e))
        .is_err());
    assert!(h.market.try_open_round(&id).is_err());
    assert_eq!(h.market.get_round(&id).status, RoundStatus::Draft);
}
