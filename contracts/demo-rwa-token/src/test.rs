extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

#[test]
fn admin_mints_and_holder_transfers() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let holder = Address::generate(&e);
    let recipient = Address::generate(&e);
    let address = e.register(
        DemoRwaToken,
        (
            admin.clone(),
            String::from_str(&e, "QuietBook Demo Note"),
            String::from_str(&e, "QBNOTE"),
        ),
    );
    let token = DemoRwaTokenClient::new(&e, &address);

    token.mint(&holder, &1_000);
    token.transfer(&holder, &recipient, &400);

    assert_eq!(token.admin(), admin);
    assert_eq!(token.balance(&holder), 600);
    assert_eq!(token.balance(&recipient), 400);
    assert_eq!(token.decimals(), 7);
}
