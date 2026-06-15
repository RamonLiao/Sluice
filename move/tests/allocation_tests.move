#[test_only]
/// Allocation tests (spec §11). Covers the three pillars the payday correctness relies on:
/// - **D10 staging**: `stage_ratios`/`promote_if_due` apply no sooner than the *next* period
///   (anti-frontrun); live ratios are untouched until promotion.
/// - **Sum invariant**: `stage_ratios` rejects bps != 10000 (E_RATIOS_SUM).
/// - **`route` value conservation + D8 fallback**: net == scallop + navi + liquid structurally;
///   a paused vault folds its bucket into liquid and reports 0, not a loss.
/// Plus monkey/extreme cases. WHY each assert matters is noted inline.
module payroll_flow::allocation_tests;

use payroll_flow::allocation;
use payroll_flow::mock_scallop::{Self, MockScallopVault, AdminCap as ScallopAdmin};
use payroll_flow::mock_navi::{Self, MockNaviVault, AdminCap as NaviAdmin};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

/// Test underlying coin type (stands in for testnet USDC).
public struct USDC has drop {}

const EMPLOYER: address = @0xE;
const ALICE: address = @0xA1;
const PAYROLL: address = @0x9A; // stand-in ID source for the cap's payroll_id

fun mk_clock(s: &mut Scenario): Clock { clock::create_for_testing(s.ctx()) }
fun mint_usdc(amt: u64, s: &mut Scenario): Coin<USDC> { coin::mint_for_testing<USDC>(amt, s.ctx()) }

/// Create + share both vaults, return their AdminCaps to EMPLOYER. rate 0 / drift-free so route
/// math is exact and the sum-check isn't perturbed by appreciation.
fun setup_vaults(s: &mut Scenario, clock: &Clock) {
    let sa = mock_scallop::create<USDC>(0, clock, s.ctx());
    let na = mock_navi::create<USDC>(1_000_000, s.ctx());
    transfer::public_transfer(sa, EMPLOYER);
    transfer::public_transfer(na, EMPLOYER);
}

// ---------------------------------------------------------------------------
// D10 staging / promotion
// ---------------------------------------------------------------------------

#[test]
/// WHY: a brand-new employee must default to 100% liquid with nothing staged — payday before any
/// `set_ratios` must route everything to the employee as cash, never silently into a vault.
fun default_is_full_liquid_no_pending() {
    let cfg = allocation::default_config_for_testing();
    assert!(allocation::liquid_bps(&cfg) == 10000, 0);
    assert!(allocation::scallop_usdc_bps(&cfg) == 0, 1);
    assert!(allocation::navi_btc_bps(&cfg) == 0, 2);
    assert!(!allocation::has_pending(&cfg), 3);
}

#[test]
/// WHY (D10 anti-frontrun core): staging at period P must NOT change live ratios and must set
/// effective period P+1. If live ratios changed immediately, an employee could rewrite the split
/// of a payday already being processed.
fun stage_does_not_change_live_ratios_and_targets_next_period() {
    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 7, 5000, 3000, 2000);
    // live ratios still default
    assert!(allocation::liquid_bps(&cfg) == 10000, 0);
    assert!(allocation::has_pending(&cfg), 1);
    assert!(allocation::pending_effective_period(&cfg) == option::some(8), 2); // P+1
}

#[test]
/// WHY: promotion must be a no-op until the effective period arrives, then apply exactly once and
/// clear pending. Off-by-one here would either leak the change a period early (frontrun) or never.
fun promote_only_when_due() {
    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 7, 5000, 3000, 2000); // effective period 8

    allocation::promote_if_due(&mut cfg, 7); // not due
    assert!(allocation::liquid_bps(&cfg) == 10000, 0);
    assert!(allocation::has_pending(&cfg), 1);

    allocation::promote_if_due(&mut cfg, 8); // due
    assert!(allocation::liquid_bps(&cfg) == 5000, 2);
    assert!(allocation::scallop_usdc_bps(&cfg) == 3000, 3);
    assert!(allocation::navi_btc_bps(&cfg) == 2000, 4);
    assert!(!allocation::has_pending(&cfg), 5); // cleared

    allocation::promote_if_due(&mut cfg, 9); // idempotent no-op
    assert!(allocation::liquid_bps(&cfg) == 5000, 6);
}

#[test]
/// WHY: a second stage before promotion must replace the first (last-write-wins), not stack. The
/// employee changed their mind; only the latest intent should land next period.
fun restage_overwrites_pending() {
    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 1, 5000, 5000, 0);
    allocation::stage_ratios(&mut cfg, 1, 0, 0, 10000);
    allocation::promote_if_due(&mut cfg, 2);
    assert!(allocation::navi_btc_bps(&cfg) == 10000, 0);
    assert!(allocation::liquid_bps(&cfg) == 0, 1);
}

#[test]
/// WHY (spec §5 pause): `stage_pause` is sugar for "100% liquid next period" — used to opt out of
/// vault exposure for a cycle. Must obey the same next-period timing.
fun pause_stages_full_liquid_next_period() {
    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 3, 0, 10000, 0); // currently all scallop
    allocation::promote_if_due(&mut cfg, 4);
    allocation::stage_pause(&mut cfg, 4);
    allocation::promote_if_due(&mut cfg, 5);
    assert!(allocation::liquid_bps(&cfg) == 10000, 0);
    assert!(allocation::scallop_usdc_bps(&cfg) == 0, 1);
}

#[test]
#[expected_failure(abort_code = 4, location = payroll_flow::allocation)]
/// WHY: ratios that don't sum to 10000 must abort (E_RATIOS_SUM=4). A config summing to <10000 would
/// strand funds; >10000 would try to over-split and abort mid-route. Reject at the gate.
fun stage_bad_sum_aborts() {
    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 0, 5000, 3000, 1000); // sums 9000
}

// ---------------------------------------------------------------------------
// route() — split, deposit, value conservation, D8 fallback
// ---------------------------------------------------------------------------

#[test]
/// WHY (the central payday invariant): for a 50/30/20 split of 1_000_000, route must deposit exactly
/// 300k scallop + 200k navi and return 500k liquid — and net == scallop + navi + liquid with zero leak.
/// This is the on-chain truth the auditor sum-check (UC3) verifies against the event.
fun route_splits_three_buckets_and_conserves_value() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup_vaults(&mut s, &clock);

    s.next_tx(EMPLOYER);
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();

    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 0, 5000, 3000, 2000);
    allocation::promote_if_due(&mut cfg, 1);

    let (liquid, scallop_amt, navi_amt) =
        allocation::route(mint_usdc(1_000_000, &mut s), &cfg, &mut scallop, &mut navi, ALICE, &clock, s.ctx());

    assert!(scallop_amt == 300_000, 0);
    assert!(navi_amt == 200_000, 1);
    assert!(liquid.value() == 500_000, 2);
    // structural conservation
    assert!(scallop_amt + navi_amt + liquid.value() == 1_000_000, 3);
    // navi position credited to ALICE (not the EMPLOYER sender) — custody seam
    assert!(mock_navi::position_of(&navi, ALICE) == 200_000, 4);

    coin::burn_for_testing(liquid);
    ts::return_shared(scallop);
    ts::return_shared(navi);
    // ALICE holds the scallop receipt
    s.next_tx(ALICE);
    let receipt = s.take_from_sender<Coin<payroll_flow::mock_scallop::MockSCoin<USDC>>>();
    assert!(receipt.value() == 300_000, 5);
    coin::burn_for_testing(receipt);

    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY (D8): a paused Scallop vault must NOT abort payday — its bucket folds into liquid and reports 0.
/// Employees still get paid in full (as cash); no value is lost or stuck in a dead vault.
fun route_scallop_paused_folds_into_liquid() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup_vaults(&mut s, &clock);

    s.next_tx(EMPLOYER);
    let admin = s.take_from_sender<ScallopAdmin>();
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();
    mock_scallop::set_active(&admin, &mut scallop, false); // outage

    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 0, 5000, 3000, 2000);
    allocation::promote_if_due(&mut cfg, 1);

    let (liquid, scallop_amt, navi_amt) =
        allocation::route(mint_usdc(1_000_000, &mut s), &cfg, &mut scallop, &mut navi, ALICE, &clock, s.ctx());

    assert!(scallop_amt == 0, 0);             // reported truthfully
    assert!(navi_amt == 200_000, 1);          // navi unaffected
    assert!(liquid.value() == 800_000, 2);    // 500k liquid + 300k folded scallop
    assert!(scallop_amt + navi_amt + liquid.value() == 1_000_000, 3);

    coin::burn_for_testing(liquid);
    transfer::public_transfer(admin, EMPLOYER);
    ts::return_shared(scallop);
    ts::return_shared(navi);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY (D8, both down — worst case): both vaults paused must still pay the full amount as liquid, with
/// both reported amounts 0. The payday is resilient to total DeFi-layer outage.
fun route_both_paused_all_liquid() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup_vaults(&mut s, &clock);

    s.next_tx(EMPLOYER);
    let sadmin = s.take_from_sender<ScallopAdmin>();
    let nadmin = s.take_from_sender<NaviAdmin>();
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();
    mock_scallop::set_active(&sadmin, &mut scallop, false);
    mock_navi::set_active(&nadmin, &mut navi, false);

    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 0, 0, 6000, 4000); // 0 liquid intended
    allocation::promote_if_due(&mut cfg, 1);

    let (liquid, scallop_amt, navi_amt) =
        allocation::route(mint_usdc(777_777, &mut s), &cfg, &mut scallop, &mut navi, ALICE, &clock, s.ctx());

    assert!(scallop_amt == 0, 0);
    assert!(navi_amt == 0, 1);
    assert!(liquid.value() == 777_777, 2); // everything falls back to liquid
    assert!(mock_navi::position_of(&navi, ALICE) == 0, 3);

    coin::burn_for_testing(liquid);
    transfer::public_transfer(sadmin, EMPLOYER);
    transfer::public_transfer(nadmin, EMPLOYER);
    ts::return_shared(scallop);
    ts::return_shared(navi);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY (rounding/monkey): with bps that don't divide evenly, integer-division dust must land in liquid,
/// never overpay a vault. 1/3 splits of 100 → 33 each, 34 dust to liquid; sum stays exact.
fun route_rounding_dust_goes_to_liquid() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup_vaults(&mut s, &clock);

    s.next_tx(EMPLOYER);
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();

    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 0, 3334, 3333, 3333); // ~1/3 each
    allocation::promote_if_due(&mut cfg, 1);

    let (liquid, scallop_amt, navi_amt) =
        allocation::route(mint_usdc(100, &mut s), &cfg, &mut scallop, &mut navi, ALICE, &clock, s.ctx());

    // floor(100*3333/10000)=33 each; liquid = floor(100*3334/10000)=33 + 1 dust = 34
    assert!(scallop_amt == 33, 0);
    assert!(navi_amt == 33, 1);
    assert!(liquid.value() == 34, 2);
    assert!(scallop_amt + navi_amt + liquid.value() == 100, 3); // no leak, no overpay

    coin::burn_for_testing(liquid);
    ts::return_shared(scallop);
    ts::return_shared(navi);
    // drain ALICE's receipt
    s.next_tx(ALICE);
    let receipt = s.take_from_sender<Coin<payroll_flow::mock_scallop::MockSCoin<USDC>>>();
    coin::burn_for_testing(receipt);
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY (monkey, single bucket): 100% to one active vault must deposit the whole net and return a
/// zero-value liquid coin (not abort). Zero-amount buckets are skipped, so no spurious vault call.
fun route_full_scallop_zero_liquid() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup_vaults(&mut s, &clock);

    s.next_tx(EMPLOYER);
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();

    let mut cfg = allocation::default_config_for_testing();
    allocation::stage_ratios(&mut cfg, 0, 0, 10000, 0);
    allocation::promote_if_due(&mut cfg, 1);

    let (liquid, scallop_amt, navi_amt) =
        allocation::route(mint_usdc(500_000, &mut s), &cfg, &mut scallop, &mut navi, ALICE, &clock, s.ctx());

    assert!(scallop_amt == 500_000, 0);
    assert!(navi_amt == 0, 1);
    assert!(liquid.value() == 0, 2); // zero-value remainder is fine

    coin::burn_for_testing(liquid);
    ts::return_shared(scallop);
    ts::return_shared(navi);
    s.next_tx(ALICE);
    let receipt = s.take_from_sender<Coin<payroll_flow::mock_scallop::MockSCoin<USDC>>>();
    assert!(receipt.value() == 500_000, 3);
    coin::burn_for_testing(receipt);
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// cap accessors
// ---------------------------------------------------------------------------

#[test]
/// WHY: the payroll-side `set_ratios` wrapper authorizes by reading these accessors (cap.payroll_id /
/// cap.employee) and matching them to the EmployeeRecord. If they returned wrong values, auth breaks.
fun cap_accessors_expose_binding() {
    let mut s = ts::begin(EMPLOYER);
    let pid = object::id_from_address(PAYROLL);
    let cap = allocation::new_cap_for_testing(pid, ALICE, s.ctx());
    assert!(allocation::cap_payroll_id(&cap) == pid, 0);
    assert!(allocation::cap_employee(&cap) == ALICE, 1);
    transfer::public_transfer(cap, ALICE);
    s.end();
}
