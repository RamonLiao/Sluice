#[test_only]
/// Payroll tests (spec §11) — the core money-flow + auth收口 module. Covers:
/// - **Value conservation** end-to-end: gross == withholding + scallop + navi + liquid, via real
///   `pay_one` against shared escrow + both mock vaults (not just `route` in isolation).
/// - **Capability auth** (#2/#3 deferred HIGH): `PayrollOwnerCap` (fund/pay/remit/migrate) and
///   `AllocationCap` (set_ratios/pause) both rejected on mismatch.
/// - **D10 anti-frontrun**: a ratio change staged at period P does NOT alter a payday run at period P.
/// - **D11 version gate**: stale object aborts; `migrate` bumps both Payroll + escrow.
/// - **D8/D9**: paused vault folds to liquid; stale FX flags, never aborts.
/// - Monkey: gross=0, 100% withholding, insufficient funding, unknown employee.
/// WHY each assert matters is noted inline.
module payroll_flow::payroll_tests;

use payroll_flow::payroll::{Self, Payroll, PayrollOwnerCap};
use payroll_flow::escrow::{Self, TaxEscrow};
use payroll_flow::allocation::{Self, AllocationCap};
use payroll_flow::mock_scallop::{Self, MockScallopVault, MockSCoin, AdminCap as ScallopAdmin};
use payroll_flow::mock_navi::{Self, MockNaviVault, AdminCap as NaviAdmin};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

/// Test underlying coin type (stands in for testnet USDC).
public struct USDC has drop {}

const EMPLOYER: address = @0xE;
const ALICE: address = @0xA1;
const BOB: address = @0xB0;
const AUTHORITY: address = @0x7A; // tax authority remit target

fun mk_clock(s: &mut Scenario): Clock { clock::create_for_testing(s.ctx()) }
fun mint_usdc(amt: u64, s: &mut Scenario): Coin<USDC> { coin::mint_for_testing<USDC>(amt, s.ctx()) }

/// First tx: share Payroll + escrow + both vaults; caps to EMPLOYER. rate 0 / drift-free so route math
/// is exact (appreciation would perturb the receipt value but never the conserved-sum check).
fun setup(s: &mut Scenario, clock: &Clock) {
    let cap = payroll::create_payroll_for_testing<USDC>(s.ctx()); // also creates + shares the bound escrow
    transfer::public_transfer(cap, EMPLOYER);
    let sa = mock_scallop::create<USDC>(0, clock, s.ctx());
    let na = mock_navi::create<USDC>(1_000_000, s.ctx());
    transfer::public_transfer(sa, EMPLOYER);
    transfer::public_transfer(na, EMPLOYER);
}

/// Second tx (EMPLOYER): fund the pool and register ALICE with the given gross/withholding.
fun fund_and_add(s: &mut Scenario, funding: u64, gross: u64, wh_bps: u16) {
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    payroll::fund(&mut payroll, &cap, mint_usdc(funding, s));
    payroll::add_employee(&mut payroll, &cap, ALICE, b"AR", gross, wh_bps, s.ctx());
    ts::return_shared(payroll);
    s.return_to_sender(cap);
}

// ---------------------------------------------------------------------------
// Setup / registration
// ---------------------------------------------------------------------------

#[test]
/// WHY: a fresh payroll must record funding and the employee exactly; the AllocationCap must reach the
/// employee (not the employer) — it's the employee's authority over their own ratios.
fun setup_funds_and_registers_employee() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    s.next_tx(EMPLOYER);
    {
        let payroll = s.take_shared<Payroll<USDC>>();
        assert!(payroll::funding_value(&payroll) == 10_000, 0);
        assert!(payroll::has_employee(&payroll, ALICE), 1);
        assert!(payroll::employee_gross(&payroll, ALICE) == 1_000, 2);
        assert!(payroll::current_period(&payroll) == 0, 3);
        ts::return_shared(payroll);
    };
    // AllocationCap landed with the employee, not the employer.
    s.next_tx(ALICE);
    {
        let acap = s.take_from_sender<AllocationCap>();
        assert!(allocation::cap_employee(&acap) == ALICE, 4);
        s.return_to_sender(acap);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// pay_one — value conservation
// ---------------------------------------------------------------------------

#[test]
/// WHY (core invariant): default 100% liquid. gross 1000 @ 10% withholding → escrow 100, employee 900.
/// gross == withholding + liquid; nothing leaks, nothing is conjured.
fun pay_one_default_liquid_conserves_value() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();

        payroll::begin_period(&mut payroll, &cap);
        payroll::pay_one(
            &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
            ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
        );

        // escrow withheld 100; funding drawn down by full gross.
        assert!(escrow::balance_of(&escrow, b"AR") == 100, 0);
        assert!(payroll::funding_value(&payroll) == 9_000, 1);
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        ts::return_shared(scallop);
        ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    // ALICE got 900 liquid.
    s.next_tx(ALICE);
    {
        let c = s.take_from_sender<Coin<USDC>>();
        assert!(c.value() == 900, 2);
        s.return_to_sender(c);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY: the three-bucket split must conserve net across escrow + scallop receipt + navi position +
/// liquid. net 900 @ 50/30/20 → scallop 270 (receipt), navi 180 (position), liquid 450. Sum-check holds.
fun pay_one_three_bucket_split_conserves() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    // ALICE stages 50/30/20 at period 0 → effective period 1.
    s.next_tx(ALICE);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let acap = s.take_from_sender<AllocationCap>();
        payroll::set_ratios(&mut payroll, &acap, ALICE, 5000, 3000, 2000);
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

        payroll::begin_period(&mut payroll, &cap); // period -> 1, change now due
        payroll::pay_one(
            &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
            ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
        );

        assert!(escrow::balance_of(&escrow, b"AR") == 100, 0);
        assert!(mock_navi::position_of(&navi, ALICE) == 180, 1); // navi bucket
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        ts::return_shared(scallop);
        ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    // ALICE got 450 liquid + a 270-share scallop receipt (rate 0 ⇒ shares == value).
    s.next_tx(ALICE);
    {
        let liquid = s.take_from_sender<Coin<USDC>>();
        assert!(liquid.value() == 450, 2);
        let receipt = s.take_from_sender<Coin<MockSCoin<USDC>>>();
        assert!(receipt.value() == 270, 3);
        s.return_to_sender(liquid);
        s.return_to_sender(receipt);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// D10 anti-frontrun
// ---------------------------------------------------------------------------

#[test]
/// WHY (D10 core): with the payday open at period 1, ALICE stages a 0%-liquid split — effective period 2.
/// The period-1 payday MUST still use live 100% liquid: an employee cannot rewrite the split of a payday
/// at the current period. (Paying at period 0 is now forbidden by the double-pay guard, so we open period 1
/// first — staging then targets period 2, the same anti-frontrun property one period up.)
fun staged_change_does_not_affect_current_period_payday() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    // EMPLOYER opens period 1.
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
        payroll::set_ratios(&mut payroll, &acap, ALICE, 0, 10000, 0); // dodge to scallop, effective period 2
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
        // Still period 1, staged change (effective 2) NOT yet due.
        payroll::pay_one(
            &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
            ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
        );
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        ts::return_shared(scallop);
        ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    s.next_tx(ALICE);
    {
        // Still full 900 liquid — no scallop receipt minted this period.
        let liquid = s.take_from_sender<Coin<USDC>>();
        assert!(liquid.value() == 900, 0);
        assert!(!ts::has_most_recent_for_sender<Coin<MockSCoin<USDC>>>(&s), 1);
        s.return_to_sender(liquid);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// D8 vault outage / D9 stale FX
// ---------------------------------------------------------------------------

#[test]
/// WHY (D8): a paused scallop vault must fold its bucket into liquid, not abort the payday. ALICE 50/30/20;
/// scallop paused → scallop bucket (270) returns as liquid → liquid 720, navi 180. Payday completes.
fun paused_scallop_folds_into_liquid() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    s.next_tx(ALICE);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let acap = s.take_from_sender<AllocationCap>();
        payroll::set_ratios(&mut payroll, &acap, ALICE, 5000, 3000, 2000);
        ts::return_shared(payroll);
        s.return_to_sender(acap);
    };

    // EMPLOYER pauses scallop (admin demo).
    s.next_tx(EMPLOYER);
    {
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let admin = s.take_from_sender<ScallopAdmin>();
        mock_scallop::set_active(&admin, &mut scallop, false);
        ts::return_shared(scallop);
        s.return_to_sender(admin);
    };

    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();
        payroll::begin_period(&mut payroll, &cap);
        payroll::pay_one(
            &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
            ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
        );
        assert!(mock_navi::position_of(&navi, ALICE) == 180, 0); // navi still routed
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        ts::return_shared(scallop);
        ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    s.next_tx(ALICE);
    {
        let liquid = s.take_from_sender<Coin<USDC>>();
        assert!(liquid.value() == 720, 1); // 450 intended liquid + 270 folded scallop
        assert!(!ts::has_most_recent_for_sender<Coin<MockSCoin<USDC>>>(&s), 2); // no receipt
        s.return_to_sender(liquid);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY (D9): FX older than 60s must NOT abort — payday proceeds and the event would carry fx_stale=true.
/// clock advanced to 120_000ms, publish_time 0 → 120s stale. Payment still completes (escrow + liquid set).
fun stale_fx_does_not_abort_payday() {
    let mut s = ts::begin(EMPLOYER);
    let mut clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    clock.set_for_testing(120_000); // 120s past publish_time 0
    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();
        payroll::begin_period(&mut payroll, &cap);
        payroll::pay_one(
            &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
            ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
        );
        assert!(escrow::balance_of(&escrow, b"AR") == 100, 0); // proceeded
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        ts::return_shared(scallop);
        ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// remit
// ---------------------------------------------------------------------------

#[test]
/// WHY: remit moves escrowed withholding to the tax authority. After a payday escrow holds 100 for AR;
/// remit 100 → authority receives a 100 coin, escrow bucket drains to 0. Owner-gated end-to-end.
fun remit_pays_authority_and_drains_bucket() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();
        payroll::begin_period(&mut payroll, &cap);
        payroll::pay_one(
            &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
            ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
        );
        payroll::remit(&payroll, &cap, &mut escrow, b"AR", 100, AUTHORITY, s.ctx());
        assert!(escrow::balance_of(&escrow, b"AR") == 0, 0);
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        ts::return_shared(scallop);
        ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    s.next_tx(AUTHORITY);
    {
        let c = s.take_from_sender<Coin<USDC>>();
        assert!(c.value() == 100, 1);
        s.return_to_sender(c);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// D11 version gate + migrate
// ---------------------------------------------------------------------------

#[test]
/// WHY (D11): after an upgrade a stale object (version 0) must be migrated; migrate bumps BOTH Payroll
/// and escrow to the package VERSION so the old module version is fenced off.
fun migrate_bumps_both_objects() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        payroll::set_version_for_testing(&mut payroll, 0);
        escrow::set_version_for_testing(&mut escrow, 0);
        payroll::migrate(&mut payroll, &cap, &mut escrow);
        assert!(payroll::version(&payroll) == payroll::package_version(), 0);
        assert!(escrow::version(&escrow) == escrow::package_version(), 1);
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        s.return_to_sender(cap);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// Monkey / extreme
// ---------------------------------------------------------------------------

#[test]
/// WHY (monkey): 100% withholding (wh_bps 10000) → entire gross to escrow, net 0, no liquid coin of value.
/// Sum-check (gross == withholding + 0) must hold; payday must not abort on a zero net.
fun full_withholding_net_zero() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 10_000); // 100% withholding

    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();
        payroll::begin_period(&mut payroll, &cap);
        payroll::pay_one(
            &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
            ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
        );
        assert!(escrow::balance_of(&escrow, b"AR") == 1_000, 0);
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        ts::return_shared(scallop);
        ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

#[test]
/// WHY (monkey): gross 0 → all amounts 0, sum-check 0==0 holds, payday completes (a zero coin is fine).
fun zero_gross_completes() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 0, 1_000);

    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        let mut escrow = s.take_shared<TaxEscrow<USDC>>();
        let mut scallop = s.take_shared<MockScallopVault<USDC>>();
        let mut navi = s.take_shared<MockNaviVault<USDC>>();
        payroll::begin_period(&mut payroll, &cap);
        payroll::pay_one(
            &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
            ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
        );
        assert!(payroll::funding_value(&payroll) == 10_000, 0); // nothing drawn
        ts::return_shared(payroll);
        ts::return_shared(escrow);
        ts::return_shared(scallop);
        ts::return_shared(navi);
        s.return_to_sender(cap);
    };
    clock::destroy_for_testing(clock);
    s.end();
}

// ---------------------------------------------------------------------------
// Abort paths — auth + bounds (red-team)
// ---------------------------------------------------------------------------

#[test, expected_failure(abort_code = 3, location = payroll_flow::payroll)]
/// WHY: funding shortfall must abort the whole PTB (E_INSUFFICIENT_FUNDING), never pay a partial gross.
fun insufficient_funding_aborts() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 500, 1_000, 1_000); // funded < gross

    s.next_tx(EMPLOYER);
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    let mut escrow = s.take_shared<TaxEscrow<USDC>>();
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();
    payroll::begin_period(&mut payroll, &cap);
    payroll::pay_one(
        &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
        ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
    );
    abort
}

#[test, expected_failure(abort_code = 5, location = payroll_flow::payroll)]
/// WHY: withholding_bps > 10000 would underflow net — must be rejected at registration (E_WITHHOLDING_RANGE).
fun withholding_over_range_aborts() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    payroll::add_employee(&mut payroll, &cap, ALICE, b"AR", 1_000, 10_001, s.ctx());
    abort
}

#[test, expected_failure(abort_code = 1, location = payroll_flow::payroll)]
/// WHY (red-team #1): a forged/foreign PayrollOwnerCap must not drain funding. A cap minted for a DIFFERENT
/// payroll fails the both-directions owner check (E_NOT_OWNER).
fun foreign_owner_cap_rejected() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    // Pin the victim payroll's id BEFORE a second one exists, so take_shared can't grab the wrong object.
    s.next_tx(EMPLOYER);
    let victim_id = {
        let p = s.take_shared<Payroll<USDC>>();
        let id = object::id(&p);
        ts::return_shared(p);
        id
    };
    // A second, unrelated payroll mints its own cap — attacker tries it on the victim payroll.
    s.next_tx(BOB);
    let evil_cap = payroll::create_payroll_for_testing<USDC>(s.ctx());

    s.next_tx(EMPLOYER);
    let mut payroll = ts::take_shared_by_id<Payroll<USDC>>(&s, victim_id);
    payroll::fund(&mut payroll, &evil_cap, mint_usdc(1, &mut s));
    transfer::public_transfer(evil_cap, BOB);
    abort
}

#[test, expected_failure(abort_code = 2, location = payroll_flow::payroll)]
/// WHY (red-team #2): an employee cannot mutate another's ratios. BOB's AllocationCap used against ALICE's
/// record fails the cap↔record check (E_NOT_ALLOCATION_OWNER).
fun foreign_allocation_cap_rejected() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    s.next_tx(EMPLOYER);
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let pid = payroll::owner_cap_id(&payroll); // any ID; cap_employee mismatch trips first
    // Forge a cap naming BOB (wrong employee) and aim it at ALICE's record.
    let evil = allocation::new_cap_for_testing(pid, BOB, s.ctx());
    payroll::set_ratios(&mut payroll, &evil, ALICE, 5000, 3000, 2000);
    transfer::public_transfer(evil, BOB);
    abort
}

#[test, expected_failure(abort_code = 7, location = payroll_flow::payroll)]
/// WHY: paying an unregistered address must abort (E_UNKNOWN_EMPLOYEE), not silently no-op or create state.
fun pay_unknown_employee_aborts() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    {
        let mut payroll = s.take_shared<Payroll<USDC>>();
        let cap = s.take_from_sender<PayrollOwnerCap>();
        payroll::fund(&mut payroll, &cap, mint_usdc(10_000, &mut s));
        ts::return_shared(payroll);
        s.return_to_sender(cap);
    };
    s.next_tx(EMPLOYER);
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    let mut escrow = s.take_shared<TaxEscrow<USDC>>();
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();
    payroll::begin_period(&mut payroll, &cap);
    payroll::pay_one(
        &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
        BOB, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
    );
    abort
}

#[test, expected_failure(abort_code = 9, location = payroll_flow::payroll)]
/// WHY (D11): a stale-version object must abort on any mutating entry (E_WRONG_VERSION) until migrated.
fun stale_version_aborts() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    payroll::set_version_for_testing(&mut payroll, 99); // simulate stale module
    payroll::fund(&mut payroll, &cap, mint_usdc(1, &mut s));
    abort
}

#[test, expected_failure(abort_code = 1, location = payroll_flow::payroll)]
/// WHY (red-team #1, remit path): the escrow drain is owner-gated — a foreign cap cannot remit.
fun remit_foreign_cap_rejected() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    let victim_id = {
        let p = s.take_shared<Payroll<USDC>>();
        let id = object::id(&p);
        ts::return_shared(p);
        id
    };
    s.next_tx(BOB);
    let evil_cap = payroll::create_payroll_for_testing<USDC>(s.ctx());

    s.next_tx(EMPLOYER);
    let payroll = ts::take_shared_by_id<Payroll<USDC>>(&s, victim_id);
    let mut escrow = s.take_shared<TaxEscrow<USDC>>();
    payroll::remit(&payroll, &evil_cap, &mut escrow, b"AR", 1, AUTHORITY, s.ctx());
    transfer::public_transfer(evil_cap, BOB);
    abort
}

#[test, expected_failure(abort_code = 11, location = payroll_flow::payroll)]
/// WHY (red-team round 5 regression): a replayed PTB must not double-pay. Two `pay_one` for ALICE in the
/// same period (no intervening begin_period) aborts (E_ALREADY_PAID_THIS_PERIOD) — on-chain backstop, not
/// orchestrator trust.
fun double_pay_same_period_aborts() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    s.next_tx(EMPLOYER);
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    let mut escrow = s.take_shared<TaxEscrow<USDC>>();
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();
    payroll::begin_period(&mut payroll, &cap);
    payroll::pay_one(
        &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
        ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
    );
    payroll::pay_one( // same period, no begin_period — must abort
        &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
        ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
    );
    abort
}

#[test, expected_failure(abort_code = 11, location = payroll_flow::payroll)]
/// WHY (period≥1 contract, intentional not incidental): paying before any `begin_period` (still period 0)
/// must abort. The double-pay guard `last_paid_period(0) < period(0)` is false, structurally enforcing
/// "a payday must be opened before anyone is paid" — there is no valid business state of paying at period 0.
fun pay_at_period_zero_aborts() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    s.next_tx(EMPLOYER);
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    let mut escrow = s.take_shared<TaxEscrow<USDC>>();
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();
    // No begin_period — current_period is still 0.
    payroll::pay_one(
        &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
        ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
    );
    abort
}

#[test, expected_failure(abort_code = 12, location = payroll_flow::payroll)]
/// WHY (red-team round 3 regression): a valid owner cap cannot route into a foreign escrow. `pay_one` with
/// an unbound `TaxEscrow<USDC>` aborts (E_WRONG_ESCROW), closing the cross-tenant drain the #2 HIGH left open.
fun pay_one_foreign_escrow_rejected() {
    let mut s = ts::begin(EMPLOYER);
    let clock = mk_clock(&mut s);
    setup(&mut s, &clock);
    s.next_tx(EMPLOYER);
    fund_and_add(&mut s, 10_000, 1_000, 1_000);

    // A second, unbound escrow of the same coin type.
    s.next_tx(EMPLOYER);
    let foreign_escrow_id = {
        let e = escrow::new_for_testing<USDC>(s.ctx());
        let id = object::id(&e);
        escrow::share(e);
        id
    };

    s.next_tx(EMPLOYER);
    let mut payroll = s.take_shared<Payroll<USDC>>();
    let cap = s.take_from_sender<PayrollOwnerCap>();
    let mut escrow = ts::take_shared_by_id<TaxEscrow<USDC>>(&s, foreign_escrow_id);
    let mut scallop = s.take_shared<MockScallopVault<USDC>>();
    let mut navi = s.take_shared<MockNaviVault<USDC>>();
    payroll::begin_period(&mut payroll, &cap);
    payroll::pay_one(
        &mut payroll, &cap, &mut escrow, &mut scallop, &mut navi,
        ALICE, b"USD/ARS", 1_000_000, 0, &clock, s.ctx(),
    );
    abort
}
