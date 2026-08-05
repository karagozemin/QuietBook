#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, xdr::ToXdr,
    Address, Bytes, BytesN, Env, Vec,
};
use stellar_tokens::confidential::{
    storage as confidential_storage, ConfidentialTokenClient, SpenderTransferData,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoundStatus {
    Draft,
    Open,
    Closed,
    Settled,
    Failed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundConfig {
    pub issuer: Address,
    pub rwa_token: Address,
    pub rwa_lot: i128,
    pub confidential_token: Address,
    pub controller: Address,
    pub eligibility_policy: Address,
    pub max_bid_verifier: Address,
    pub auditor_id: u32,
    pub reserve_public: i128,
    pub bid_deadline_ledger: u32,
    pub settlement_deadline_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Round {
    pub id: BytesN<32>,
    pub config: RoundConfig,
    pub status: RoundStatus,
    pub bidder_count: u32,
    pub participant_set_hash: Option<BytesN<32>>,
    pub winner: Option<Address>,
    pub proof_hash: Option<BytesN<32>>,
    pub rwa_escrowed: bool,
    pub rwa_reclaimed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidRegistration {
    pub round_id: BytesN<32>,
    pub bidder: Address,
    pub registration_index: u32,
    pub registered_ledger: u32,
    pub active: bool,
}

#[contracttype]
enum DataKey {
    NextRound,
    Round(BytesN<32>),
    Bidders(BytesN<32>),
    Bid(BytesN<32>, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MarketError {
    InvalidRoundConfig = 4000,
    RoundNotFound = 4001,
    RoundNotDraft = 4002,
    RoundNotOpen = 4003,
    BidDeadlinePassed = 4004,
    BidDeadlineNotReached = 4005,
    InvestorNotAuthorized = 4006,
    DelegationNotFound = 4007,
    DelegationExpired = 4008,
    BidAlreadyRegistered = 4009,
    RwaEscrowInsufficient = 4010,
    RoundNotClosed = 4011,
    RwaAlreadyReclaimed = 4012,
    InvalidFailureTransition = 4013,
    BidCapacityReached = 4014,
    NoSaleNotAvailable = 4015,
    ControllerConfigurationMismatch = 4016,
    WinnerIndexInvalid = 4017,
    MaxProofInvalid = 4018,
    SettlementDeadlinePassed = 4019,
    RoundAlreadySettled = 4020,
}

const MAX_BIDDERS: u32 = 3;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundCreated {
    #[topic]
    pub round_id: BytesN<32>,
    #[topic]
    pub issuer: Address,
    pub config: RoundConfig,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RwaFunded {
    #[topic]
    pub round_id: BytesN<32>,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundOpened {
    #[topic]
    pub round_id: BytesN<32>,
    pub opened_ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidRegistered {
    #[topic]
    pub round_id: BytesN<32>,
    #[topic]
    pub bidder: Address,
    pub registration_index: u32,
    pub registered_ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundClosed {
    #[topic]
    pub round_id: BytesN<32>,
    pub bidder_count: u32,
    pub participant_set_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundFailed {
    #[topic]
    pub round_id: BytesN<32>,
    pub reason_code: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RwaReclaimed {
    #[topic]
    pub round_id: BytesN<32>,
    #[topic]
    pub issuer: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WinnerProven {
    #[topic]
    pub round_id: BytesN<32>,
    #[topic]
    pub winner: Address,
    pub proof_hash: BytesN<32>,
    pub participant_set_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundSettled {
    #[topic]
    pub round_id: BytesN<32>,
    #[topic]
    pub winner: Address,
    pub proof_hash: BytesN<32>,
}

#[contractclient(name = "EligibilityPolicyClient")]
pub trait EligibilityPolicy {
    fn is_authorized(e: Env, account: Address, token: Address) -> bool;
}

#[contractclient(name = "RoundControllerClient")]
pub trait RoundControllerInterface {
    fn configuration(e: Env) -> (Address, Address, Address, u32, bool);
    fn register(e: Env, auditor_id: u32, register_data: Bytes);
    fn settle(e: Env, from: Address, spender_transfer_data: Bytes);
}

#[contractclient(name = "MaxBidVerifierClient")]
pub trait MaxBidVerifierInterface {
    fn verify(e: Env, public_inputs: Bytes, proof: Bytes) -> bool;
}

#[contract]
pub struct QuietBookMarket;

#[contractimpl]
impl QuietBookMarket {
    pub fn create_round(e: Env, config: RoundConfig) -> BytesN<32> {
        config.issuer.require_auth();
        validate_config(&e, &config);

        let sequence = e
            .storage()
            .instance()
            .get::<_, u64>(&DataKey::NextRound)
            .unwrap_or(0);
        let id = BytesN::from_array(
            &e,
            &e.crypto()
                .sha256(&(e.current_contract_address(), sequence, config.clone()).to_xdr(&e))
                .to_array(),
        );
        e.storage()
            .instance()
            .set(&DataKey::NextRound, &(sequence + 1));

        let round = Round {
            id: id.clone(),
            config,
            status: RoundStatus::Draft,
            bidder_count: 0,
            participant_set_hash: None,
            winner: None,
            proof_hash: None,
            rwa_escrowed: false,
            rwa_reclaimed: false,
        };
        e.storage()
            .persistent()
            .set(&DataKey::Round(id.clone()), &round);
        e.storage()
            .persistent()
            .set(&DataKey::Bidders(id.clone()), &Vec::<Address>::new(&e));
        RoundCreated {
            round_id: id.clone(),
            issuer: round.config.issuer.clone(),
            config: round.config.clone(),
        }
        .publish(&e);
        id
    }

    pub fn fund_round(e: Env, round_id: BytesN<32>) {
        let mut round = load_round(&e, &round_id);
        round.config.issuer.require_auth();
        require_status(&e, &round, RoundStatus::Draft, MarketError::RoundNotDraft);
        if round.rwa_escrowed {
            panic_with(&e, MarketError::RwaEscrowInsufficient);
        }

        soroban_sdk::token::TokenClient::new(&e, &round.config.rwa_token).transfer(
            &round.config.issuer,
            e.current_contract_address(),
            &round.config.rwa_lot,
        );
        round.rwa_escrowed = true;
        RwaFunded {
            round_id,
            amount: round.config.rwa_lot,
        }
        .publish(&e);
        save_round(&e, &round);
    }

    pub fn open_round(e: Env, round_id: BytesN<32>) {
        let mut round = load_round(&e, &round_id);
        round.config.issuer.require_auth();
        require_status(&e, &round, RoundStatus::Draft, MarketError::RoundNotDraft);
        if e.ledger().sequence() > round.config.bid_deadline_ledger {
            panic_with(&e, MarketError::BidDeadlinePassed);
        }
        if !round.rwa_escrowed
            || soroban_sdk::token::TokenClient::new(&e, &round.config.rwa_token)
                .balance(&e.current_contract_address())
                < round.config.rwa_lot
        {
            panic_with(&e, MarketError::RwaEscrowInsufficient);
        }
        if !controller_configuration_matches(&e, &round, true) {
            panic_with(&e, MarketError::ControllerConfigurationMismatch);
        }
        round.status = RoundStatus::Open;
        RoundOpened {
            round_id,
            opened_ledger: e.ledger().sequence(),
        }
        .publish(&e);
        save_round(&e, &round);
    }

    pub fn register_controller(
        e: Env,
        round_id: BytesN<32>,
        auditor_id: u32,
        register_data: Bytes,
    ) {
        let round = load_round(&e, &round_id);
        round.config.issuer.require_auth();
        require_status(&e, &round, RoundStatus::Draft, MarketError::RoundNotDraft);
        if !controller_configuration_matches(&e, &round, false) {
            panic_with(&e, MarketError::ControllerConfigurationMismatch);
        }
        RoundControllerClient::new(&e, &round.config.controller)
            .register(&auditor_id, &register_data);
        if !controller_configuration_matches(&e, &round, true) {
            panic_with(&e, MarketError::ControllerConfigurationMismatch);
        }
    }

    pub fn register_bid(e: Env, round_id: BytesN<32>, bidder: Address) {
        bidder.require_auth();
        let mut round = load_round(&e, &round_id);
        require_status(&e, &round, RoundStatus::Open, MarketError::RoundNotOpen);
        if e.ledger().sequence() > round.config.bid_deadline_ledger {
            panic_with(&e, MarketError::BidDeadlinePassed);
        }
        if e.storage()
            .persistent()
            .has(&DataKey::Bid(round_id.clone(), bidder.clone()))
        {
            panic_with(&e, MarketError::BidAlreadyRegistered);
        }
        if round.bidder_count >= MAX_BIDDERS {
            panic_with(&e, MarketError::BidCapacityReached);
        }
        if !EligibilityPolicyClient::new(&e, &round.config.eligibility_policy)
            .is_authorized(&bidder, &round.config.confidential_token)
        {
            panic_with(&e, MarketError::InvestorNotAuthorized);
        }

        let token = ConfidentialTokenClient::new(&e, &round.config.confidential_token);
        if !token.is_spender(&bidder, &round.config.controller) {
            panic_with(&e, MarketError::DelegationNotFound);
        }
        let delegation = token.get_spender_delegation(&bidder, &round.config.controller);
        if delegation.live_until_ledger < round.config.settlement_deadline_ledger {
            panic_with(&e, MarketError::DelegationExpired);
        }

        let registration = BidRegistration {
            round_id: round_id.clone(),
            bidder: bidder.clone(),
            registration_index: round.bidder_count,
            registered_ledger: e.ledger().sequence(),
            active: true,
        };
        let mut bidders = load_bidders(&e, &round_id);
        bidders.push_back(bidder.clone());
        round.bidder_count += 1;
        e.storage()
            .persistent()
            .set(&DataKey::Bid(round_id.clone(), bidder), &registration);
        e.storage()
            .persistent()
            .set(&DataKey::Bidders(round_id), &bidders);
        BidRegistered {
            round_id: registration.round_id.clone(),
            bidder: registration.bidder.clone(),
            registration_index: registration.registration_index,
            registered_ledger: registration.registered_ledger,
        }
        .publish(&e);
        save_round(&e, &round);
    }

    pub fn close_round(e: Env, round_id: BytesN<32>) -> BytesN<32> {
        let mut round = load_round(&e, &round_id);
        require_status(&e, &round, RoundStatus::Open, MarketError::RoundNotOpen);
        if e.ledger().sequence() <= round.config.bid_deadline_ledger {
            panic_with(&e, MarketError::BidDeadlineNotReached);
        }
        let bidders = load_bidders(&e, &round_id);
        let hash = BytesN::from_array(
            &e,
            &e.crypto()
                .sha256(&(round_id.clone(), bidders).to_xdr(&e))
                .to_array(),
        );
        round.status = RoundStatus::Closed;
        round.participant_set_hash = Some(hash.clone());
        RoundClosed {
            round_id,
            bidder_count: round.bidder_count,
            participant_set_hash: hash.clone(),
        }
        .publish(&e);
        save_round(&e, &round);
        hash
    }

    pub fn cancel_round(e: Env, round_id: BytesN<32>) {
        let mut round = load_round(&e, &round_id);
        round.config.issuer.require_auth();
        require_status(&e, &round, RoundStatus::Draft, MarketError::RoundNotDraft);
        round.status = RoundStatus::Cancelled;
        save_round(&e, &round);
    }

    pub fn mark_no_sale(e: Env, round_id: BytesN<32>) {
        let mut round = load_round(&e, &round_id);
        round.config.issuer.require_auth();
        require_status(&e, &round, RoundStatus::Closed, MarketError::RoundNotClosed);
        let reason_code = if round.bidder_count == 0 {
            0
        } else if e.ledger().sequence() > round.config.settlement_deadline_ledger {
            1
        } else {
            panic_with(&e, MarketError::NoSaleNotAvailable);
        };
        round.status = RoundStatus::Failed;
        RoundFailed {
            round_id,
            reason_code,
        }
        .publish(&e);
        save_round(&e, &round);
    }

    pub fn reclaim_rwa(e: Env, round_id: BytesN<32>) {
        let mut round = load_round(&e, &round_id);
        round.config.issuer.require_auth();
        if round.status != RoundStatus::Failed && round.status != RoundStatus::Cancelled {
            panic_with(&e, MarketError::InvalidFailureTransition);
        }
        if !round.rwa_escrowed || round.rwa_reclaimed {
            panic_with(&e, MarketError::RwaAlreadyReclaimed);
        }
        soroban_sdk::token::TokenClient::new(&e, &round.config.rwa_token).transfer(
            &e.current_contract_address(),
            &round.config.issuer,
            &round.config.rwa_lot,
        );
        round.rwa_reclaimed = true;
        if round.status == RoundStatus::Failed {
            round.status = RoundStatus::Cancelled;
        }
        RwaReclaimed {
            round_id,
            issuer: round.config.issuer.clone(),
            amount: round.config.rwa_lot,
        }
        .publish(&e);
        save_round(&e, &round);
    }

    pub fn max_bid_public_inputs(
        e: Env,
        round_id: BytesN<32>,
        winner_index: u32,
        spender_transfer_data: Bytes,
    ) -> Bytes {
        let round = load_round(&e, &round_id);
        require_status(&e, &round, RoundStatus::Closed, MarketError::RoundNotClosed);
        build_max_bid_public_inputs(&e, &round, winner_index, &spender_transfer_data)
    }

    pub fn finalize(
        e: Env,
        round_id: BytesN<32>,
        winner_index: u32,
        max_bid_proof: Bytes,
        spender_transfer_data: Bytes,
    ) {
        let mut round = load_round(&e, &round_id);
        if round.status == RoundStatus::Settled {
            panic_with(&e, MarketError::RoundAlreadySettled);
        }
        require_status(&e, &round, RoundStatus::Closed, MarketError::RoundNotClosed);
        if e.ledger().sequence() > round.config.settlement_deadline_ledger {
            panic_with(&e, MarketError::SettlementDeadlinePassed);
        }

        let bidders = load_bidders(&e, &round_id);
        let winner = bidders
            .get(winner_index)
            .unwrap_or_else(|| panic_with(&e, MarketError::WinnerIndexInvalid));
        let public_inputs =
            build_max_bid_public_inputs(&e, &round, winner_index, &spender_transfer_data);
        if !MaxBidVerifierClient::new(&e, &round.config.max_bid_verifier)
            .verify(&public_inputs, &max_bid_proof)
        {
            panic_with(&e, MarketError::MaxProofInvalid);
        }

        let proof_hash = BytesN::from_array(&e, &e.crypto().sha256(&max_bid_proof).to_array());
        RoundControllerClient::new(&e, &round.config.controller)
            .settle(&winner, &spender_transfer_data);
        soroban_sdk::token::TokenClient::new(&e, &round.config.rwa_token).transfer(
            &e.current_contract_address(),
            &winner,
            &round.config.rwa_lot,
        );

        round.status = RoundStatus::Settled;
        round.winner = Some(winner.clone());
        round.proof_hash = Some(proof_hash.clone());
        let participant_set_hash = round
            .participant_set_hash
            .clone()
            .unwrap_or_else(|| panic_with(&e, MarketError::RoundNotClosed));
        WinnerProven {
            round_id: round_id.clone(),
            winner: winner.clone(),
            proof_hash: proof_hash.clone(),
            participant_set_hash,
        }
        .publish(&e);
        RoundSettled {
            round_id,
            winner,
            proof_hash,
        }
        .publish(&e);
        save_round(&e, &round);
    }

    pub fn get_round(e: Env, round_id: BytesN<32>) -> Round {
        load_round(&e, &round_id)
    }

    pub fn get_bidders(e: Env, round_id: BytesN<32>) -> Vec<Address> {
        load_round(&e, &round_id);
        load_bidders(&e, &round_id)
    }

    pub fn get_bid(e: Env, round_id: BytesN<32>, bidder: Address) -> Option<BidRegistration> {
        load_round(&e, &round_id);
        e.storage()
            .persistent()
            .get(&DataKey::Bid(round_id, bidder))
    }
}

fn validate_config(e: &Env, config: &RoundConfig) {
    if config.rwa_lot <= 0
        || config.reserve_public < 0
        || config.bid_deadline_ledger <= e.ledger().sequence()
        || config.settlement_deadline_ledger <= config.bid_deadline_ledger
    {
        panic_with(e, MarketError::InvalidRoundConfig);
    }
}

fn controller_configuration_matches(e: &Env, round: &Round, expected_registered: bool) -> bool {
    let controller = RoundControllerClient::new(e, &round.config.controller);
    let (market, token, issuer, deadline, registered) = controller.configuration();
    market == e.current_contract_address()
        && token == round.config.confidential_token
        && issuer == round.config.issuer
        && deadline == round.config.settlement_deadline_ledger
        && registered == expected_registered
}

fn load_round(e: &Env, id: &BytesN<32>) -> Round {
    e.storage()
        .persistent()
        .get(&DataKey::Round(id.clone()))
        .unwrap_or_else(|| panic_with(e, MarketError::RoundNotFound))
}

fn save_round(e: &Env, round: &Round) {
    e.storage()
        .persistent()
        .set(&DataKey::Round(round.id.clone()), round);
}

fn load_bidders(e: &Env, id: &BytesN<32>) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::Bidders(id.clone()))
        .unwrap_or(Vec::new(e))
}

fn build_max_bid_public_inputs(
    e: &Env,
    round: &Round,
    winner_index: u32,
    spender_transfer_data: &Bytes,
) -> Bytes {
    if winner_index >= round.bidder_count {
        panic_with(e, MarketError::WinnerIndexInvalid);
    }
    let participant_set_hash = round
        .participant_set_hash
        .clone()
        .unwrap_or_else(|| panic_with(e, MarketError::RoundNotClosed));
    let domain_hash = e.crypto().sha256(
        &(
            e.current_contract_address(),
            round.id.clone(),
            round.config.clone(),
            participant_set_hash,
        )
            .to_xdr(e),
    );
    let mut domain = domain_hash.to_array();
    domain[0] = 0;

    let bidders = load_bidders(e, &round.id);
    let token = ConfidentialTokenClient::new(e, &round.config.confidential_token);
    let mut public_inputs = Bytes::new(e);
    public_inputs.extend_from_array(&domain);
    for index in 0..MAX_BIDDERS {
        if index < round.bidder_count {
            let bidder = bidders
                .get(index)
                .unwrap_or_else(|| panic_with(e, MarketError::WinnerIndexInvalid));
            if !token.is_spender(&bidder, &round.config.controller) {
                panic_with(e, MarketError::DelegationNotFound);
            }
            let delegation = token.get_spender_delegation(&bidder, &round.config.controller);
            public_inputs.append(&Bytes::from(delegation.allowance_commitment));
        } else {
            public_inputs.extend_from_array(&[0u8; 64]);
        }
    }
    for index in 0..MAX_BIDDERS {
        append_u32_field(&mut public_inputs, e, u32::from(index < round.bidder_count));
    }
    append_amount_field(&mut public_inputs, e, round.config.reserve_public);
    append_u32_field(&mut public_inputs, e, winner_index);

    let transfer: SpenderTransferData = confidential_storage::decode_data(e, spender_transfer_data);
    public_inputs.append(&Bytes::from(transfer.payload.c_transfer));
    public_inputs
}

fn append_u32_field(bytes: &mut Bytes, e: &Env, value: u32) {
    let mut encoded = [0u8; 32];
    encoded[28..].copy_from_slice(&value.to_be_bytes());
    bytes.append(&Bytes::from_array(e, &encoded));
}

fn append_amount_field(bytes: &mut Bytes, e: &Env, value: i128) {
    let mut encoded = [0u8; 32];
    encoded[16..].copy_from_slice(&value.to_be_bytes());
    bytes.append(&Bytes::from_array(e, &encoded));
}

fn require_status(e: &Env, round: &Round, expected: RoundStatus, error: MarketError) {
    if round.status != expected {
        panic_with(e, error);
    }
}

fn panic_with(e: &Env, error: MarketError) -> ! {
    soroban_sdk::panic_with_error!(e, error)
}

#[cfg(test)]
mod test;
