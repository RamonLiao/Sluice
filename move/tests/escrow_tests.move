#[test_only]
/// Tests for `payroll_flow::escrow` (TODO #2). Exercises per-jurisdiction segregation,
/// reserve/withdraw value conservation, the D11 version gate, and monkey/extreme cases
/// (empty withdraw, exact drain, zero withholding, repeated accumulation).
module payroll_flow::escrow_tests;

use sui::balance;
use sui::coin;
use sui::test_scenario::{Self as ts, Scenario};
use payroll_flow::escrow::{Self, TaxEscrow};

/// Test underlying coin type (stands in for testnet USDC), matching vaults_tests.
public struct USDC has drop {}

const AR: vector<u8> = b"AR";
const US: vector<u8> = b"US-1099";

fun bal(amt: u64): balance::Balance<USDC> { balance::create_for_testing<USDC>(amt) }

fun fresh(s: &mut Scenario): TaxEscrow<USDC> { escrow::new_for_testing<USDC>(s.ctx()) }

// --- reserve / balance_of ---

#[test]
fun reserve_creates_bucket_and_reports_balance() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(1_000));
    assert!(e.balance_of(AR) == 1_000, 0);
    assert!(e.balance_of(US) == 0, 1); // unseen jurisdiction reads 0, not abort
    e.share();
    s.end();
}

#[test]
fun reserve_accumulates_same_jurisdiction() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(1_000));
    e.reserve(AR, bal(250));
    e.reserve(AR, bal(750));
    assert!(e.balance_of(AR) == 2_000, 0);
    e.share();
    s.end();
}

#[test]
fun jurisdictions_are_segregated() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(1_000));
    e.reserve(US, bal(4_000));
    assert!(e.balance_of(AR) == 1_000, 0);
    assert!(e.balance_of(US) == 4_000, 1);
    e.share();
    s.end();
}

#[test]
fun reserve_zero_withholding_is_allowed() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(0)); // 0% jurisdictions (e.g. some 1099) must not abort
    assert!(e.balance_of(AR) == 0, 0);
    e.reserve(AR, bal(500)); // and the bucket already exists → join path
    assert!(e.balance_of(AR) == 500, 1);
    e.share();
    s.end();
}

// --- withdraw ---

#[test]
fun withdraw_happy_path_reduces_bucket() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(1_000));
    let c = e.withdraw(AR, 300, s.ctx());
    assert!(c.value() == 300, 0);
    assert!(e.balance_of(AR) == 700, 1);
    c.burn_for_testing();
    e.share();
    s.end();
}

#[test]
fun withdraw_exact_drain_leaves_zero() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(1_000));
    let c = e.withdraw(AR, 1_000, s.ctx());
    assert!(c.value() == 1_000, 0);
    assert!(e.balance_of(AR) == 0, 1);
    c.burn_for_testing();
    e.share();
    s.end();
}

#[test]
fun withdraw_zero_amount_is_noop_coin() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(1_000));
    let c = e.withdraw(AR, 0, s.ctx());
    assert!(c.value() == 0, 0);
    assert!(e.balance_of(AR) == 1_000, 1);
    c.burn_for_testing();
    e.share();
    s.end();
}

#[test, expected_failure(abort_code = escrow::EUnknownJurisdiction)]
fun withdraw_unknown_jurisdiction_aborts() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(1_000));
    let c = e.withdraw(US, 1, s.ctx()); // never reserved
    coin::burn_for_testing(c);
    abort
}

#[test, expected_failure(abort_code = escrow::EInsufficientEscrow)]
fun withdraw_over_balance_aborts() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(1_000));
    let c = e.withdraw(AR, 1_001, s.ctx());
    coin::burn_for_testing(c);
    abort
}

// --- D11 version gate ---

#[test]
fun migrate_promotes_stale_object() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.set_version_for_testing(0); // simulate pre-upgrade object
    e.migrate();
    assert!(e.version() == escrow::package_version(), 0);
    e.reserve(AR, bal(1)); // mutating entry now passes assert_version
    e.share();
    s.end();
}

#[test, expected_failure(abort_code = escrow::ENotUpgrade)]
fun migrate_when_current_aborts() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.migrate(); // already at VERSION → one-shot guard fires
    e.share();
    s.end();
}

#[test, expected_failure(abort_code = escrow::EWrongVersion)]
fun reserve_on_stale_version_aborts() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.set_version_for_testing(999); // mismatch package VERSION
    e.reserve(AR, bal(1));
    e.share();
    s.end();
}

#[test, expected_failure(abort_code = escrow::EWrongVersion)]
fun withdraw_on_stale_version_aborts() {
    let mut s = ts::begin(@0x1);
    let mut e = fresh(&mut s);
    e.reserve(AR, bal(1_000));
    e.set_version_for_testing(999);
    let c = e.withdraw(AR, 1, s.ctx());
    coin::burn_for_testing(c);
    abort
}
