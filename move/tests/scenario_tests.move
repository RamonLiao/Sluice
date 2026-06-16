#[test_only]
/// Scenario / integration tests (TODO #6) — the gaps the per-module suites leave open.
///
/// The existing `payroll_tests` exhaustively cover ONE employee paid ONCE: value conservation, auth,
/// D8/D9/D10/D11, and every abort path. What they never exercise is the actual production shape of a
/// payday — `begin_period` once, then a *batch* of `pay_one` across *many* employees, repeated across
/// *many* periods. This file covers exactly that cross-cut:
///   A. multi-employee batch in one period (per-employee buckets + funding drawdown are independent),
///   B. same employee paid across consecutive periods (`last_paid_period` advances, no false double-pay),
///   C. a staged ratio change promotes at the *correct* later period while the in-between payday uses the
///      live config (D10 anti-frontrun proven over a real period boundary, not a single bumped period),
///   D. a full lifecycle: create → fund → add×2 → 2 paydays → remit accumulated withholding,
///   E. monkey: a mid-batch funding shortfall aborts the whole PTB (atomicity — no partial payday).
/// WHY each assert matters is noted inline.
module payroll_flow::scenario_tests;

use payroll_flow::payroll::{Self, Payroll, PayrollOwnerCap};
use payroll_flow::escrow::{Self, TaxEscrow};
use payroll_flow::allocation::{Self, AllocationCap};
use payroll_flow::mock_scallop::{Self, MockScallopVault, MockSCoin};
use payroll_flow::mock_navi::{Self, MockNaviVault};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

/// Test underlying coin type (stands in for testnet USDC).
public struct USDC has drop {}

const EMPLOYER: address = @0xE;
const ALICE: address = @0xA1;
const BOB: address = @0xB0;
const AUTHORITY: address = @0x7A;

fun mk_clock(s: &mut Scenario): Clock { clock::create_for_testing(s.ctx()) }
fun mint_usdc(amt: u64, s: &mut Scenario): Coin<USDC> { coin::mint_for_testing<USDC>(amt, s.ctx()) }

/// First tx: create + share Payroll (+ its bound escrow) and both vaults; caps to EMPLOYER. Scallop rate 0
/// and navi index 1_000_000 so route math is drift-free and exact (shares == value, position == amount).
fun setup(s: &mut Scenario, clock: &Clock) {
    let cap = payroll::create_payroll_for_testing<USDC>(s.ctx());
    transfer::public_transfer(cap, EMPLOYER);
    let sa = mock_scallop::create<USDC>(0, clock, s.ctx());
    let na = mock_navi::create<USDC>(1_000_000, s.ctx());
    transfer::public_transfer(sa, EMPLOYER);
    transfer::public_transfer(na, EMPLOYER);
}

/// EMPLOYER funds the pool and registers an employee with the given jurisdiction/gross/withholding.
fun fund(s: &mut Scenario, amount: u64) {
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    payroll::fund(&mut payroll, &cap, mint_usdc(amount, s));
    ts::return_shared(payroll);
    s.return_to_sender(cap);
}

fun add(s: &mut Scenario, who: address, jur: vector<u8>, gross: u64, wh_bps: u16) {
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    payroll::add_employee(&mut payroll, &cap, who, jur, gross, wh_bps, s.ctx());
    ts::return_shared(payroll);
    s.return_to_sender(cap);
}

/// EMPLOYER pays `who` (default-liquid path; jurisdiction is read from the record). Caller owns the tx.
fun pay(
    payroll: &mut Payroll<USDC>,
    cap: &PayrollOwnerCap,
    escrow: &mut TaxEscrow<USDC>,
    scallop: &mut MockScallopVault<USDC>,
    navi: &mut MockNaviVault<USDC>,
    who: address,
    clock: &Clock,
    s: &mut Scenario,
) {
    payroll::pay_one(payroll, cap, escrow, scallop, navi, who, b"USD/ARS", 1_000_000, 0, clock, s.ctx());
}

// ---------------------------------------------------------------------------
// A. Multi-employee batch in one period
// ---------------------------------------------------------------------------

#[test]
/// WHY: a real payday pays many employees under ONE `begin_period`. Each must draw its own gross, withhold
/// into its own jurisdiction bucket, and pay its own liquid — independently, with no cross-contamination.
/// ALICE: gross 1000 @ 10% (AR) → escrow.AR 100, liquid 900. BOB: gross 2000 @ 5% (BR) → escrow.BR 100,
/// liquid 1900. Pool drawn by 3000 exactly; the two escrow buckets are disjoint.
fun multi_employee_batch_one_period() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER); fund(&mut s, 100_000);
    s.next_tx(EMPLOYER); add(&mut s, ALICE, b"AR", 1_000, 1_000);
    s.next_tx(EMPLOYER); add(&mut s, BOB, b"BR", 2_000, 500);

    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();

        payroll::begin_period(&mut payroll, &cap); // one begin for the whole batch
        pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, ALICE, &clock, &mut s);
        pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, BOB, &clock, &mut s);

        assert!(escrow::balance_of(&escrow, b"AR") == 100, 0);
        assert!(escrow::balance_of(&escrow, b"BR") == 100, 1); // disjoint bucket, not merged with AR
        assert!(payroll::funding_value(&payroll) == 97_000, 2); // 100k - 1000 - 2000
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        ts::return_shared(scallop);
        ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    s.next_tx(ALICE);
    { let c = s.take_from_sender<Coin<USDC>>(); assert!(c.value() == 900, 3); s.return_to_sender(c); };
    s.next_tx(BOB);
    { let c = s.take_from_sender<Coin<USDC>>(); assert!(c.value() == 1_900, 4); s.return_to_sender(c); };

    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// B. Same employee paid across consecutive periods
// ---------------------------------------------------------------------------

#[test]
/// WHY (D10 idempotency across periods): the double-pay guard must block a *replay within* a period yet
/// allow the *next* period's legitimate payday. Pay ALICE at P1 and again at P2 (each preceded by its own
/// `begin_period`). `last_paid_period` advances 1 → 2; both succeed; pool drawn twice; escrow accumulates.
fun same_employee_paid_two_periods() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER); fund(&mut s, 10_000);
    s.next_tx(EMPLOYER); add(&mut s, ALICE, b"AR", 1_000, 1_000);

    // Period 1 payday.
    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();
        payroll::begin_period(&mut payroll, &cap);
        pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, ALICE, &clock, &mut s);
        assert!(payroll::current_period(&payroll) == 1, 0);
        ts::return_shared(payroll); ts::return_shared(escrow);
        ts::return_shared(scallop); ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    // Period 2 payday — same employee, legitimately paid again.
    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();
        payroll::begin_period(&mut payroll, &cap);
        pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, ALICE, &clock, &mut s);
        assert!(payroll::current_period(&payroll) == 2, 1);
        assert!(escrow::balance_of(&escrow, b"AR") == 200, 2);   // 100 + 100 accumulated
        assert!(payroll::funding_value(&payroll) == 8_000, 3);   // 10k - 1000 - 1000
        ts::return_shared(payroll); ts::return_shared(escrow);
        ts::return_shared(scallop); ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// C. Staged ratio promotes at the correct later period
// ---------------------------------------------------------------------------

#[test]
/// WHY (D10 over a real boundary): a ratio change staged DURING period 1 must NOT touch the period-1 payday
/// and must take effect at period 2. Distinct from `payroll_tests`, which stages at period 0 and pays at the
/// immediately-bumped period 1 — here a full P1 payday runs on the live 100%-liquid config first, then the
/// staged 50/30/20 promotes only at P2. Proves `promote_if_due` fires on the period boundary, not before.
fun staged_ratio_promotes_next_period() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER); fund(&mut s, 10_000);
    s.next_tx(EMPLOYER); add(&mut s, ALICE, b"AR", 1_000, 1_000);

    // P1: open, then ALICE stages 50/30/20 (effective P2), then P1 payday runs on LIVE 100% liquid.
    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        payroll::begin_period(&mut payroll, &cap);
        ts::return_shared(payroll);
        s.return_to_sender(cap);
    };
    s.next_tx(ALICE);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let acap = s.take_from_sender<AllocationCap>();
        payroll::set_ratios(&mut payroll, &acap, ALICE, 5000, 3000, 2000); // staged @P1 → effective P2
        ts::return_shared(payroll);
        s.return_to_sender(acap);
    };
    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();
        pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, ALICE, &clock, &mut s); // still P1
        ts::return_shared(payroll); ts::return_shared(escrow);
        ts::return_shared(scallop); ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    // P1 result: full 900 liquid, no scallop receipt — staged change did NOT apply.
    s.next_tx(ALICE);
    {
        let liquid = s.take_from_sender<Coin<USDC>>();
        assert!(liquid.value() == 900, 0);
        assert!(!ts::has_most_recent_for_sender<Coin<MockSCoin<USDC>>>(&s), 1);
        s.return_to_sender(liquid);
    };

    // P2: open + pay → staged 50/30/20 now promotes. liquid 450, navi 180, scallop receipt 270.
    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();
        payroll::begin_period(&mut payroll, &cap); // period -> 2, staged change now due
        pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, ALICE, &clock, &mut s);
        assert!(mock_navi::position_of(&navi, ALICE) == 180u128, 2);
        ts::return_shared(payroll); ts::return_shared(escrow);
        ts::return_shared(scallop); ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    s.next_tx(ALICE);
    {
        let liquid = s.take_from_sender<Coin<USDC>>(); // most-recent = the P2 liquid (450)
        assert!(liquid.value() == 450, 3);
        let receipt = s.take_from_sender<Coin<MockSCoin<USDC>>>();
        assert!(receipt.value() == 270, 4);
        s.return_to_sender(liquid);
        s.return_to_sender(receipt);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// D. Full lifecycle: create → fund → add×2 → 2 paydays → remit
// ---------------------------------------------------------------------------

#[test]
/// WHY (end-to-end): the whole employer journey in one run. Two employees, two periods, then a single remit
/// that drains AR's accumulated withholding to the tax authority. ALICE AR 10% gross 1000 → 100/period;
/// after two periods escrow.AR == 200; remit 200 → AUTHORITY receives 200, bucket drains to 0.
fun full_lifecycle_two_periods_then_remit() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER); fund(&mut s, 100_000);
    s.next_tx(EMPLOYER); add(&mut s, ALICE, b"AR", 1_000, 1_000);
    s.next_tx(EMPLOYER); add(&mut s, BOB, b"AR", 2_000, 1_000); // same jurisdiction → shared bucket

    // Two paydays.
    let mut period = 0;
    while (period < 2) {
        s.next_tx(EMPLOYER);
        {
            let mut payroll = s.take_shared<Payroll<USDC>>();
            let cap = s.take_from_sender<PayrollOwnerCap>();
            let mut escrow = s.take_shared<TaxEscrow<USDC>>();
            let mut scallop = s.take_shared<MockScallopVault<USDC>>();
            let mut navi = s.take_shared<MockNaviVault<USDC>>();
            payroll::begin_period(&mut payroll, &cap);
            pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, ALICE, &clock, &mut s);
            pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, BOB, &clock, &mut s);
            ts::return_shared(payroll); ts::return_shared(escrow);
            ts::return_shared(scallop); ts::return_shared(navi);
            s.return_to_sender(cap);
        };
        period = period + 1;
    };

    // Remit the accumulated AR withholding: (100 + 200) * 2 periods = 600.
    s.next_tx(EMPLOYER);
    {
        let payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        assert!(escrow::balance_of(&escrow, b"AR") == 600, 0);
        payroll::remit(&payroll, &cap, &mut escrow, b"AR", 600, AUTHORITY, s.ctx());
        assert!(escrow::balance_of(&escrow, b"AR") == 0, 1);
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        s.return_to_sender(cap);
    };
    s.next_tx(AUTHORITY);
    { let c = s.take_from_sender<Coin<USDC>>(); assert!(c.value() == 600, 2); s.return_to_sender(c); };

    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// E. Monkey: mid-batch funding shortfall aborts the whole PTB
// ---------------------------------------------------------------------------

#[test, expected_failure(abort_code = 3, location = payroll_flow::payroll)]
/// WHY (atomicity / monkey): in a batch where the pool covers ALICE but not BOB, paying BOB must abort with
/// E_INSUFFICIENT_FUNDING — and because both `pay_one`s share one PTB, ALICE's already-applied payment
/// reverts too on-chain. No employee is paid out of an underfunded run; there is no partial payday.
fun midbatch_shortfall_aborts_whole_batch() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER); fund(&mut s, 1_500);               // covers ALICE (1000) but not + BOB (2000)
    s.next_tx(EMPLOYER); add(&mut s, ALICE, b"AR", 1_000, 1_000);
    s.next_tx(EMPLOYER); add(&mut s, BOB, b"BR", 2_000, 500);

    s.next_tx(EMPLOYER);
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    let mut escrow = s.take_shared<TaxEscrow<USDC>>();
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();
    payroll::begin_period(&mut payroll, &cap);
    pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, ALICE, &clock, &mut s); // ok (pool 1500→500)
    pay(&mut payroll, &cap, &mut escrow, &mut scallop, &mut navi, BOB, &clock, &mut s);   // 500 < 2000 → abort
    abort
}
