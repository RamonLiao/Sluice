#[test_only]
/// Tests for `payroll_flow::compliance` (TODO #4). Exercises the `PayrollEventV1` field wiring, the
/// defensive sum-check (both decompositions), event emission, D9 fx pass-through, and monkey/extreme
/// cases (gross=0, 100% withholding, single-bucket, max-value sum near u64 boundary).
module payroll_flow::compliance_tests;

use sui::test_scenario::{Self as ts};
use payroll_flow::compliance;

const EMPLOYER: address = @0xE;
const EMPLOYEE: address = @0xA11CE;
const AR: vector<u8> = b"AR";
const FX_PAIR: vector<u8> = b"USD/ARS";

/// Fabricate an `ID` for the `payroll_id` field from the active scenario's ctx (no real object kept).
fun some_id(ctx: &mut TxContext): object::ID {
    let uid = object::new(ctx);
    let id = uid.to_inner();
    uid.delete();
    id
}

// --- field wiring (no emit) ---

#[test]
fun fields_round_trip() {
    let mut s = ts::begin(@0x1);
    let pid = some_id(s.ctx());
    let e = compliance::new_for_testing(
        pid, EMPLOYER, EMPLOYEE, AR, 7,
        /*gross*/ 1_000, /*withholding*/ 100, /*net*/ 900,
        /*liquid*/ 400, /*scallop*/ 300, /*navi*/ 200,
        FX_PAIR, /*fx_rate*/ 950, /*publish_time*/ 12345, /*fx_stale*/ false,
    );
    assert!(e.event_gross() == 1_000, 0);
    assert!(e.event_withholding() == 100, 1);
    assert!(e.event_net() == 900, 2);
    assert!(e.event_liquid_amt() == 400, 3);
    assert!(e.event_scallop_amt() == 300, 4);
    assert!(e.event_navi_amt() == 200, 5);
    assert!(e.event_period() == 7, 6);
    assert!(e.event_employee() == EMPLOYEE, 7);
    assert!(e.event_jurisdiction() == AR, 8);
    assert!(e.event_fx_rate() == 950, 9);
    assert!(e.event_fx_stale() == false, 10);
    s.end();
}

// --- emit happy path ---

#[test]
fun emit_records_one_event() {
    let mut s = ts::begin(EMPLOYER);
    let pid = some_id(s.ctx());
    compliance::emit_payroll_event_v1(
        pid, EMPLOYER, EMPLOYEE, AR, 3,
        1_000, 100, 900, 400, 300, 200,
        FX_PAIR, 950, 12345, false,
    );
    let fx = s.next_tx(EMPLOYER);
    assert!(fx.num_user_events() == 1, 0);
    s.end();
}

#[test]
/// Every bucket to liquid (100% liquid), withholding present. Sum-check still holds.
fun emit_single_bucket_liquid() {
    let mut s = ts::begin(EMPLOYER);
    let pid = some_id(s.ctx());
    compliance::emit_payroll_event_v1(
        pid, EMPLOYER, EMPLOYEE, AR, 1,
        1_000, 250, 750, 750, 0, 0,
        FX_PAIR, 950, 1, false,
    );
    let fx = s.next_tx(EMPLOYER);
    assert!(fx.num_user_events() == 1, 0);
    s.end();
}

// --- monkey / extreme ---

#[test]
/// gross=0 → everything zero. 0 == 0 + 0; emits cleanly.
fun emit_all_zero() {
    let mut s = ts::begin(EMPLOYER);
    let pid = some_id(s.ctx());
    compliance::emit_payroll_event_v1(
        pid, EMPLOYER, EMPLOYEE, AR, 0,
        0, 0, 0, 0, 0, 0,
        FX_PAIR, 0, 0, false,
    );
    let fx = s.next_tx(EMPLOYER);
    assert!(fx.num_user_events() == 1, 0);
    s.end();
}

#[test]
/// 100% withholding → net=0, all buckets 0. gross == withholding + 0.
fun emit_full_withholding() {
    let mut s = ts::begin(EMPLOYER);
    let pid = some_id(s.ctx());
    compliance::emit_payroll_event_v1(
        pid, EMPLOYER, EMPLOYEE, AR, 5,
        1_000, 1_000, 0, 0, 0, 0,
        FX_PAIR, 950, 1, false,
    );
    let fx = s.next_tx(EMPLOYER);
    assert!(fx.num_user_events() == 1, 0);
    s.end();
}

#[test]
/// D9: stale FX is logged, not asserted against amounts. Emits with fx_stale=true.
fun emit_stale_fx_pass_through() {
    let mut s = ts::begin(EMPLOYER);
    let pid = some_id(s.ctx());
    let e = compliance::new_for_testing(
        pid, EMPLOYER, EMPLOYEE, AR, 2,
        500, 50, 450, 450, 0, 0,
        FX_PAIR, 0, 0, /*fx_stale*/ true,
    );
    assert!(e.event_fx_stale() == true, 0);
    compliance::emit_payroll_event_v1(
        pid, EMPLOYER, EMPLOYEE, AR, 2,
        500, 50, 450, 450, 0, 0,
        FX_PAIR, 0, 0, true,
    );
    let fx = s.next_tx(EMPLOYER);
    assert!(fx.num_user_events() == 1, 1);
    s.end();
}

#[test]
/// Near-u64 amounts: sum-check must not overflow (u128 widening). gross=u64::MAX.
fun emit_max_value_no_overflow() {
    let max = 18_446_744_073_709_551_615u64; // u64::MAX
    let mut s = ts::begin(EMPLOYER);
    let pid = some_id(s.ctx());
    compliance::emit_payroll_event_v1(
        pid, EMPLOYER, EMPLOYEE, AR, 9,
        max, 1, max - 1, max - 3, 1, 1,
        FX_PAIR, 950, 1, false,
    );
    let fx = s.next_tx(EMPLOYER);
    assert!(fx.num_user_events() == 1, 0);
    s.end();
}

// --- sum-check abort paths ---

#[test]
#[expected_failure(abort_code = 100, location = payroll_flow::compliance)]
/// net != liquid + scallop + navi → ESumMismatch.
fun emit_aborts_on_bucket_mismatch() {
    let mut s = ts::begin(EMPLOYER);
    let pid = some_id(s.ctx());
    compliance::emit_payroll_event_v1(
        pid, EMPLOYER, EMPLOYEE, AR, 1,
        1_000, 100, 900, 400, 300, 199, // buckets sum to 899, not 900
        FX_PAIR, 950, 1, false,
    );
    s.end();
}

#[test]
#[expected_failure(abort_code = 100, location = payroll_flow::compliance)]
/// gross != withholding + net → ESumMismatch.
fun emit_aborts_on_gross_mismatch() {
    let mut s = ts::begin(EMPLOYER);
    let pid = some_id(s.ctx());
    compliance::emit_payroll_event_v1(
        pid, EMPLOYER, EMPLOYEE, AR, 1,
        1_000, 100, 850, 850, 0, 0, // withholding+net = 950, not 1000
        FX_PAIR, 950, 1, false,
    );
    s.end();
}
