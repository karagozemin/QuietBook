extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    Address, BytesN,
};
use stellar_tokens::confidential::SpenderDelegation;

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
}

struct Harness<'a> {
    e: Env,
    market: QuietBookMarketClient<'a>,
    policy: MockPolicyClient<'a>,
    confidential: MockConfidentialTokenClient<'a>,
    issuer: Address,
    investor: Address,
    controller: Address,
    rwa: soroban_sdk::token::StellarAssetClient<'a>,
    rwa_address: Address,
}

fn setup<'a>() -> Harness<'a> {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_sequence_number(100);

    let issuer = Address::generate(&e);
    let investor = Address::generate(&e);
    let controller = Address::generate(&e);
    let policy_address = e.register(MockPolicy, ());
    let confidential_address = e.register(MockConfidentialToken, ());
    let market_address = e.register(QuietBookMarket, ());
    let rwa = e.register_stellar_asset_contract_v2(issuer.clone());
    let rwa_address = rwa.address();

    Harness {
        market: QuietBookMarketClient::new(&e, &market_address),
        policy: MockPolicyClient::new(&e, &policy_address),
        confidential: MockConfidentialTokenClient::new(&e, &confidential_address),
        e: e.clone(),
        issuer,
        investor,
        controller,
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
        controller: h.controller.clone(),
        eligibility_policy: h.policy.address.clone(),
        max_bid_verifier: Address::generate(&h.e),
        auditor_id: 1,
        reserve_public: 9_000,
        bid_deadline_ledger: 200,
        settlement_deadline_ledger: 300,
    }
}

fn funded_open_round(h: &Harness<'_>) -> BytesN<32> {
    h.rwa.mint(&h.issuer, &1_000);
    let id = h.market.create_round(&config(h));
    h.market.fund_round(&id);
    h.market.open_round(&id);
    id
}

#[test]
fn round_requires_escrow_then_registers_only_live_eligible_bidder() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);
    h.confidential
        .set_delegation(&h.investor, &h.controller, &300);

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
fn close_freezes_ordered_participant_hash() {
    let h = setup();
    let id = funded_open_round(&h);
    h.policy.set(&h.investor, &true);
    h.confidential
        .set_delegation(&h.investor, &h.controller, &300);
    h.market.register_bid(&id, &h.investor);
    h.e.ledger().set_sequence_number(201);

    let hash = h.market.close_round(&id);
    let round = h.market.get_round(&id);
    assert_eq!(round.status, RoundStatus::Closed);
    assert_eq!(round.participant_set_hash, Some(hash));
}

#[test]
fn unauthorized_bid_is_rejected_without_registration() {
    let h = setup();
    let id = funded_open_round(&h);
    h.confidential
        .set_delegation(&h.investor, &h.controller, &300);

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
        h.confidential.set_delegation(&bidder, &h.controller, &300);
        h.market.register_bid(&id, &bidder);
    }

    let fourth = Address::generate(&h.e);
    h.policy.set(&fourth, &true);
    h.confidential.set_delegation(&fourth, &h.controller, &300);
    assert!(h.market.try_register_bid(&id, &fourth).is_err());
    assert_eq!(h.market.get_round(&id).bidder_count, 3);
}
