use stellar_confidential_lib::commit;

mod tests;

// Fixed-capacity maximum-bid statement for the hackathon MVP.
//
// Public inputs are supplied from trusted market state. The payment
// commitment is copied from the SpenderTransfer payload, which binds the
// proven winning bid to the exact confidential settlement amount.
fn main(
    round_domain: pub Field,
    c_0_x: pub Field,
    c_0_y: pub Field,
    c_1_x: pub Field,
    c_1_y: pub Field,
    c_2_x: pub Field,
    c_2_y: pub Field,
    active_0: pub bool,
    active_1: pub bool,
    active_2: pub bool,
    reserve: pub Field,
    winner_index: pub Field,
    payment_x: pub Field,
    payment_y: pub Field,
    bid_0: Field,
    blind_0: Field,
    bid_1: Field,
    blind_1: Field,
    bid_2: Field,
    blind_2: Field,
    payment_blind: Field,
) {
    assert(round_domain != 0);
    reserve.assert_max_bit_size::<127>();

    constrain_slot(active_0, bid_0, blind_0, c_0_x, c_0_y);
    constrain_slot(active_1, bid_1, blind_1, c_1_x, c_1_y);
    constrain_slot(active_2, bid_2, blind_2, c_2_x, c_2_y);

    let winner_0 = winner_index == 0;
    let winner_1 = winner_index == 1;
    let winner_2 = winner_index == 2;
    assert(winner_0 | winner_1 | winner_2);
    assert((winner_0 & active_0) | (winner_1 & active_1) | (winner_2 & active_2));

    let winning_bid = if winner_0 { bid_0 } else if winner_1 { bid_1 } else { bid_2 };
    let reserve_delta = winning_bid - reserve;
    reserve_delta.assert_max_bit_size::<127>();

    constrain_not_greater(active_0, winning_bid, bid_0);
    constrain_not_greater(active_1, winning_bid, bid_1);
    constrain_not_greater(active_2, winning_bid, bid_2);

    // Equal maxima are won by the lowest active registration index.
    if winner_1 {
        assert(!active_0 | (bid_0 != winning_bid));
    }
    if winner_2 {
        assert(!active_0 | (bid_0 != winning_bid));
        assert(!active_1 | (bid_1 != winning_bid));
    }

    let payment = commit(winning_bid, payment_blind);
    assert(payment.x == payment_x);
    assert(payment.y == payment_y);
}

fn constrain_slot(active: bool, bid: Field, blind: Field, c_x: Field, c_y: Field) {
    if active {
        bid.assert_max_bit_size::<127>();
        let commitment = commit(bid, blind);
        assert(commitment.x == c_x);
        assert(commitment.y == c_y);
    } else {
        assert(bid == 0);
        assert(blind == 0);
        assert(c_x == 0);
        assert(c_y == 0);
    }
}

fn constrain_not_greater(active: bool, winning_bid: Field, candidate: Field) {
    if active {
        let delta = winning_bid - candidate;
        delta.assert_max_bit_size::<127>();
    }
}

