extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn admin_controls_membership_and_unknown_accounts_fail_closed() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let investor = Address::generate(&e);
    let token = Address::generate(&e);
    let address = e.register(EligibilityPolicy, (admin.clone(),));
    let policy = EligibilityPolicyClient::new(&e, &address);

    assert_eq!(policy.admin(), admin);
    assert!(!policy.is_authorized(&investor, &token));
    policy.set_authorized(&investor, &true);
    assert!(policy.is_authorized(&investor, &token));
    policy.set_authorized(&investor, &false);
    assert!(!policy.is_authorized(&investor, &token));
}
