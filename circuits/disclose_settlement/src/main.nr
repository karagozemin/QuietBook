use std::embedded_curve_ops::EmbeddedCurvePoint;
use stellar_confidential_lib::{
    H, assert_on_curve_non_identity, ecdh, encrypt_amount, poseidon_with_domain, scalar_mul,
    vk_from_sk,
};

// ECDH occupies domain 13 in the pinned OpenZeppelin branch. QuietBook uses
// the next free domain for a recipient-bound disclosure ciphertext.
global DISCLOSURE: Field = 14;

fn main(
    sk: Field,
    v_tx: Field,
    r_disc: Field,
    addr_f: pub Field,
    pvk_a_x: pub Field,
    pvk_a_y: pub Field,
    r_e_x: pub Field,
    r_e_y: pub Field,
    sigma: pub Field,
    v_tilde: pub Field,
    p_r_x: pub Field,
    p_r_y: pub Field,
    nu: pub Field,
    r_disc_x: pub Field,
    r_disc_y: pub Field,
    v_tilde_disc: pub Field,
) {
    assert(r_disc != 0);

    let vk = vk_from_sk(sk, addr_f);
    let pvk_derived = scalar_mul(vk, H);
    assert(pvk_derived.x == pvk_a_x);
    assert(pvk_derived.y == pvk_a_y);

    let r_e = EmbeddedCurvePoint { x: r_e_x, y: r_e_y, is_infinite: false };
    assert_on_curve_non_identity(r_e);
    let event_shared = ecdh(vk, r_e);
    assert(encrypt_amount(v_tx, event_shared, sigma) == v_tilde);
    v_tx.assert_max_bit_size::<127>();

    let r_disc_derived = scalar_mul(r_disc, H);
    assert(r_disc_derived.x == r_disc_x);
    assert(r_disc_derived.y == r_disc_y);

    let recipient = EmbeddedCurvePoint { x: p_r_x, y: p_r_y, is_infinite: false };
    assert_on_curve_non_identity(recipient);
    let disclosure_shared = ecdh(r_disc, recipient);
    let mask = poseidon_with_domain(DISCLOSURE, [disclosure_shared, nu]);
    assert(v_tx + mask == v_tilde_disc);
}
