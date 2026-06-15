#[test_only]
/// Seam-layer tests (spec §11). Verifies the TWO deposit models behave to contract:
/// - Scallop: bearer receipt minted, appreciates with clock, redeem returns principal+yield.
/// - Navi: NO return, address-keyed credit to `beneficiary` (NOT sender), sender-gated withdraw.
/// Plus D8 liveness gating and monkey/extreme cases. WHY each assert matters is noted inline.
module payroll_flow::vaults_tests;

use payroll_flow::mock_scallop::{Self, MockScallopVault};
use payroll_flow::mock_navi::{Self, MockNaviVault};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

/// Test underlying coin type (stands in for testnet USDC).
public struct USDC has drop {}

const EMPLOYER: address = @0xE;
const ALICE: address = @0xA1;
const BOB: address = @0xB0;

fun mk_clock(s: &mut Scenario): Clock { clock::create_for_testing(s.ctx()) }
fun mint_usdc(amt: u64, s: &mut Scenario): Coin<USDC> { coin::mint_for_testing<USDC>(amt, s.ctx()) }

// ---------------------------------------------------------------------------
// Scallop receipt-coin model
// ---------------------------------------------------------------------------

#[test]
/// WHY: at index==SCALE (t0, no drift accrued) deposit must mint 1:1 shares and redeem
/// must return exactly the principal — value conservation with zero yield, the baseline
/// the payday sum-check relies on.
fun scallop_mint_redeem_no_drift_conserves_value() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_scallop::create<USDC>(0, &clock, s.ctx()); // rate 0 → no appreciation
    transfer::public_transfer(admin, EMPLOYER);

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockScallopVault<USDC>>();
    let receipt = mock_scallop::mint(&mut vault, mint_usdc(1_000_000, &mut s), &clock, s.ctx());
    assert!(receipt.value() == 1_000_000, 0); // 1:1 shares at SCALE
    let back = mock_scallop::redeem(&mut vault, receipt, &clock, s.ctx());
    assert!(back.value() == 1_000_000, 1); // principal returned, no leak
    coin::burn_for_testing(back);
    ts::return_shared(vault);

    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY: the receipt MUST appreciate as the clock advances (mirrors MarketCoin). If redeem
/// didn't pay out > principal after time passes, the "yield receipt" claim is a lie.
fun scallop_receipt_appreciates_over_time() {
    let mut s = ts::begin(EMPLOYER);
    let mut clock = mk_clock(&mut s);
    // rate = SCALE/1000 per sec → index doubles after 1000s.
    let admin = mock_scallop::create<USDC>(1_000_000_000 / 1000, &clock, s.ctx());
    transfer::public_transfer(admin, EMPLOYER);

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockScallopVault<USDC>>();
    let receipt = mock_scallop::mint(&mut vault, mint_usdc(1_000_000, &mut s), &clock, s.ctx());
    // fund extra reserves so redeem can pay accrued yield (mirror: reserves back the appreciation)
    let extra = mint_usdc(1_000_000, &mut s);
    let r2 = mock_scallop::mint(&mut vault, extra, &clock, s.ctx());

    clock::increment_for_testing(&mut clock, 1000 * 1000); // +1000s in ms → index ~2x
    let back = mock_scallop::redeem(&mut vault, receipt, &clock, s.ctx());
    assert!(back.value() > 1_000_000, 0); // appreciated

    coin::burn_for_testing(back);
    // r2 backs the appreciation reserves (the first redeem drained them); discard the
    // receipt without redeeming so we don't assert against a now-empty reserve.
    coin::burn_for_testing(r2);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
#[expected_failure(abort_code = 100, location = payroll_flow::vault_std)]
/// WHY: D8 — a paused vault must block direct redeem (last-line guard). Confirms the seam's
/// shared assert_active fires identically for both models.
fun scallop_redeem_blocked_when_inactive() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_scallop::create<USDC>(0, &clock, s.ctx());

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockScallopVault<USDC>>();
    let receipt = mock_scallop::mint(&mut vault, mint_usdc(100, &mut s), &clock, s.ctx());
    mock_scallop::set_active(&admin, &mut vault, false);
    let back = mock_scallop::redeem(&mut vault, receipt, &clock, s.ctx()); // aborts

    coin::burn_for_testing(back);
    transfer::public_transfer(admin, EMPLOYER);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
#[expected_failure(abort_code = 100, location = payroll_flow::vault_std)]
/// WHY (MED-1, D8 symmetry): a paused vault must reject DEPOSITS too, not just redeems.
/// Otherwise funds enter a vault that can't be exited. Mirrors real Scallop/Navi pause.
fun scallop_mint_blocked_when_inactive() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_scallop::create<USDC>(0, &clock, s.ctx());

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockScallopVault<USDC>>();
    mock_scallop::set_active(&admin, &mut vault, false);
    let receipt = mock_scallop::mint(&mut vault, mint_usdc(100, &mut s), &clock, s.ctx()); // aborts

    coin::burn_for_testing(receipt);
    transfer::public_transfer(admin, EMPLOYER);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
#[expected_failure(abort_code = 2, location = payroll_flow::mock_scallop)]
/// WHY monkey: a zero-value deposit is a no-op that would mint 0 shares / pollute accounting;
/// must abort loudly.
fun scallop_zero_deposit_aborts() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_scallop::create<USDC>(0, &clock, s.ctx());
    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockScallopVault<USDC>>();
    let receipt = mock_scallop::mint(&mut vault, mint_usdc(0, &mut s), &clock, s.ctx());
    coin::burn_for_testing(receipt);
    transfer::public_transfer(admin, EMPLOYER);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// Navi address-keyed model
// ---------------------------------------------------------------------------

#[test]
/// WHY (the custody seam, spec §3.1): deposit credits `beneficiary`, NOT the tx sender.
/// EMPLOYER runs the deposit but ALICE must own the position — otherwise employers custody
/// employee yield, the exact violation D3/§3.1 exists to prevent.
fun navi_deposit_credits_beneficiary_not_sender() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_navi::create<USDC>(50_000, s.ctx());
    transfer::public_transfer(admin, EMPLOYER);

    s.next_tx(EMPLOYER); // sender = EMPLOYER
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    mock_navi::deposit(&mut vault, ALICE, mint_usdc(700_000, &mut s), &clock);
    assert!(mock_navi::position_of(&vault, ALICE) == 700_000, 0); // credited to beneficiary
    assert!(mock_navi::position_of(&vault, EMPLOYER) == 0, 1);     // NOT to sender
    ts::return_shared(vault);

    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY: only the position holder (sender-keyed) can withdraw, and value is conserved.
/// Deposit by EMPLOYER for ALICE, then ALICE withdraws her own position.
fun navi_position_holder_withdraws() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_navi::create<USDC>(50_000, s.ctx());
    transfer::public_transfer(admin, EMPLOYER);

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    mock_navi::deposit(&mut vault, ALICE, mint_usdc(700_000, &mut s), &clock);
    ts::return_shared(vault);

    s.next_tx(ALICE); // sender = ALICE
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    let out = mock_navi::withdraw(&mut vault, 700_000, &clock, s.ctx());
    assert!(out.value() == 700_000, 0);
    assert!(mock_navi::position_of(&vault, ALICE) == 0, 1);
    coin::burn_for_testing(out);
    ts::return_shared(vault);

    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
#[expected_failure(abort_code = 9, location = payroll_flow::mock_navi)]
/// WHY: a stranger (no position) withdrawing must abort — address-keyed ownership gate.
/// BOB never deposited; his withdraw must fail even though reserves exist (ALICE's funds).
fun navi_non_holder_cannot_withdraw() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_navi::create<USDC>(50_000, s.ctx());
    transfer::public_transfer(admin, EMPLOYER);

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    mock_navi::deposit(&mut vault, ALICE, mint_usdc(700_000, &mut s), &clock);
    ts::return_shared(vault);

    s.next_tx(BOB);
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    let out = mock_navi::withdraw(&mut vault, 1, &clock, s.ctx()); // aborts E_NO_POSITION
    coin::burn_for_testing(out);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
#[expected_failure(abort_code = 8, location = payroll_flow::mock_navi)]
/// WHY monkey: withdrawing more than the recorded position must abort (no overdraw of
/// another employee's reserves). Matches spec §8 E_VAULT_PRINCIPAL.
fun navi_overdraw_aborts() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_navi::create<USDC>(50_000, s.ctx());
    transfer::public_transfer(admin, EMPLOYER);

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    mock_navi::deposit(&mut vault, ALICE, mint_usdc(100, &mut s), &clock);
    ts::return_shared(vault);

    s.next_tx(ALICE);
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    let out = mock_navi::withdraw(&mut vault, 101, &clock, s.ctx()); // aborts
    coin::burn_for_testing(out);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY: repeated deposits to the same beneficiary accumulate (mirrors Navi's += on user_state),
/// they don't overwrite. Off-by-one here would silently lose an employee's prior position.
fun navi_repeated_deposit_accumulates() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_navi::create<USDC>(50_000, s.ctx());
    transfer::public_transfer(admin, EMPLOYER);

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    mock_navi::deposit(&mut vault, ALICE, mint_usdc(300, &mut s), &clock);
    mock_navi::deposit(&mut vault, ALICE, mint_usdc(200, &mut s), &clock);
    assert!(mock_navi::position_of(&vault, ALICE) == 500, 0);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
#[expected_failure(abort_code = 100, location = payroll_flow::vault_std)]
/// WHY (MED-1, D8 symmetry): paused Navi vault must reject deposits too. EMPLOYER tries to
/// deposit for ALICE into a paused vault → abort, so funds can't get stranded.
fun navi_deposit_blocked_when_inactive() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_navi::create<USDC>(50_000, s.ctx());

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    mock_navi::set_active(&admin, &mut vault, false);
    mock_navi::deposit(&mut vault, ALICE, mint_usdc(100, &mut s), &clock); // aborts

    transfer::public_transfer(admin, EMPLOYER);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
#[expected_failure(abort_code = 100, location = payroll_flow::vault_std)]
/// WHY: D8 liveness gate applies to Navi withdraw too (paused vault blocks withdraw).
fun navi_withdraw_blocked_when_inactive() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    let admin = mock_navi::create<USDC>(50_000, s.ctx());

    s.next_tx(EMPLOYER);
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    mock_navi::deposit(&mut vault, ALICE, mint_usdc(100, &mut s), &clock);
    mock_navi::set_active(&admin, &mut vault, false);
    ts::return_shared(vault);

    s.next_tx(ALICE);
    let mut vault = s.take_shared<MockNaviVault<USDC>>();
    let out = mock_navi::withdraw(&mut vault, 100, &clock, s.ctx()); // aborts inactive
    coin::burn_for_testing(out);
    transfer::public_transfer(admin, EMPLOYER);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    s.end();
}
