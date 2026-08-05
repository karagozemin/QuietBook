use super::main;
use stellar_confidential_lib::commit;

fn run_case(
    bid_0: Field,
    bid_1: Field,
    bid_2: Field,
    active_2: bool,
    reserve: Field,
    winner_index: Field,
    payment_value: Field,
) {
    let blind_0: Field = 101;
    let blind_1: Field = 202;
    let blind_2: Field = if active_2 { 303 } else { 0 };
    let c_0 = commit(bid_0, blind_0);
    let c_1 = commit(bid_1, blind_1);
    let c_2 = if active_2 { commit(bid_2, blind_2) } else { commit(0, 0) };
    let payment_blind: Field = 404;
    let payment = commit(payment_value, payment_blind);

    main(
        0x5155494554424f4f4b,
        c_0.x,
        c_0.y,
        c_1.x,
        c_1.y,
        c_2.x,
        c_2.y,
        true,
        true,
        active_2,
        reserve,
        winner_index,
        payment.x,
        payment.y,
        bid_0,
        blind_0,
        bid_1,
        blind_1,
        bid_2,
        blind_2,
        payment_blind,
    );
}

#[test]
fn each_registration_index_can_win() {
    run_case(300, 200, 100, true, 50, 0, 300);
    run_case(100, 300, 200, true, 50, 1, 300);
    run_case(100, 200, 300, true, 50, 2, 300);
}

#[test]
fn inactive_third_slot_is_padded() {
    run_case(100, 200, 0, false, 50, 1, 200);
}

#[test]
fn earliest_equal_bid_wins() {
    run_case(300, 300, 100, true, 50, 0, 300);
}

#[test(should_fail)]
fn later_equal_bid_cannot_win() {
    run_case(300, 300, 100, true, 50, 1, 300);
}

#[test(should_fail)]
fn non_maximum_bid_cannot_win() {
    run_case(300, 200, 100, true, 50, 1, 200);
}

#[test(should_fail)]
fn reserve_must_be_met() {
    run_case(300, 200, 100, true, 301, 0, 300);
}

#[test(should_fail)]
fn settlement_payment_must_equal_winning_bid() {
    run_case(300, 200, 100, true, 50, 0, 299);
}

#[test(should_fail)]
fn registered_bidder_cannot_be_padded_out() {
    let c_0 = commit(300, 101);
    let c_1 = commit(200, 202);
    let registered_c_2 = commit(100, 303);
    let payment = commit(300, 404);
    main(
        0x5155494554424f4f4b,
        c_0.x, c_0.y, c_1.x, c_1.y, registered_c_2.x, registered_c_2.y,
        true, true, false, 50, 0, payment.x, payment.y,
        300, 101, 200, 202, 0, 0, 404,
    );
}

#[test(should_fail)]
fn bidder_openings_cannot_be_swapped() {
    let c_0 = commit(300, 101);
    let c_1 = commit(200, 202);
    let c_2 = commit(100, 303);
    let payment = commit(300, 404);
    main(
        0x5155494554424f4f4b,
        c_0.x, c_0.y, c_1.x, c_1.y, c_2.x, c_2.y,
        true, true, true, 50, 0, payment.x, payment.y,
        200, 202, 300, 101, 100, 303, 404,
    );
}
