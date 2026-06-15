/// Compliance — `PayrollEventV1` emission (spec §7). The versioned (`V1`) event is the auditor receipt
/// and indexer record for every per-employee payment; the `V1` suffix lets the schema survive contract
/// upgrades (spec §7).
///
/// **Leaf module by design (mirrors escrow/allocation).** The dependency direction is
/// `payroll → compliance` (module-dependency.mmd), so this module holds no shared state, no caps, and no
/// `UID`: it is pure event logging. No `version` field / `assert_version` (D11) is needed because there
/// is no shared object here to guard — the enclosing `Payroll` is version-checked in the `payroll` module
/// before the payday path reaches this emit.
///
/// The auditor sum-check (BUSINESS_SPEC UC3, spec §7) is
/// `gross == withholding + liquid_amt + scallop_amt + navi_amt`. In `payroll` it holds *structurally*
/// because every amount is split off a linear `Coin`, but this module re-asserts it (widened to u128)
/// before emitting: a drifted accounting bug must abort the payday, never emit a receipt that lies
/// (Rule 12 — fail loud).
///
/// `fx_rate` / `fx_pair` / `fx_pyth_publish_time` / `fx_stale` are reporting-and-forensics only (D9): they
/// are pass-through fields, never in the USDC value path, so stale FX is logged (`fx_stale = true`) rather
/// than asserted against the amounts.
module payroll_flow::compliance;

use sui::event;

/// Defensive invariant: `gross != withholding + liquid_amt + scallop_amt + navi_amt` (or the
/// `net` decomposition disagrees). Module-local (100+, mirrors escrow/allocation) — this is an
/// internal "this should never happen" guard, not a spec §8 user-facing error.
const ESumMismatch: u64 = 100;

/// Versioned payroll receipt (spec §7). `copy, drop`, no `key`: it is emitted, never stored.
/// Emitted exactly once per employee per payday by `payroll::pay_one`.
public struct PayrollEventV1 has copy, drop {
    payroll_id: ID,
    employer: address,
    employee: address,
    jurisdiction: vector<u8>,
    period: u64,
    gross: u64,
    withholding: u64,
    net: u64,
    liquid_amt: u64,
    scallop_amt: u64,
    navi_amt: u64,
    // §3 auditor sum-check + forensics. Reporting-only (D9), not in the value path.
    fx_pair: vector<u8>,
    fx_rate: u64,
    fx_pyth_publish_time: u64,
    // D9: true when the Pyth price was >60s stale; payday still proceeds.
    fx_stale: bool,
}

/// Build and emit the per-employee payroll receipt. `public(package)`: only `payroll` may call it, so
/// the event cannot be spoofed by an external caller. Aborts (`ESumMismatch`) if the accounting
/// invariant does not hold, so a buggy payday never emits a dishonest receipt.
public(package) fun emit_payroll_event_v1(
    payroll_id: ID,
    employer: address,
    employee: address,
    jurisdiction: vector<u8>,
    period: u64,
    gross: u64,
    withholding: u64,
    net: u64,
    liquid_amt: u64,
    scallop_amt: u64,
    navi_amt: u64,
    fx_pair: vector<u8>,
    fx_rate: u64,
    fx_pyth_publish_time: u64,
    fx_stale: bool,
) {
    // Widen to u128 so the addition itself can never overflow before the equality check.
    assert!((net as u128) == (liquid_amt as u128) + (scallop_amt as u128) + (navi_amt as u128), ESumMismatch);
    assert!((gross as u128) == (withholding as u128) + (net as u128), ESumMismatch);

    event::emit(PayrollEventV1 {
        payroll_id,
        employer,
        employee,
        jurisdiction,
        period,
        gross,
        withholding,
        net,
        liquid_amt,
        scallop_amt,
        navi_amt,
        fx_pair,
        fx_rate,
        fx_pyth_publish_time,
        fx_stale,
    });
}

// === test-only accessors ===
// Field getters let tests assert the struct wiring without depending on event-capture internals.

#[test_only]
public fun event_gross(e: &PayrollEventV1): u64 { e.gross }
#[test_only]
public fun event_withholding(e: &PayrollEventV1): u64 { e.withholding }
#[test_only]
public fun event_net(e: &PayrollEventV1): u64 { e.net }
#[test_only]
public fun event_liquid_amt(e: &PayrollEventV1): u64 { e.liquid_amt }
#[test_only]
public fun event_scallop_amt(e: &PayrollEventV1): u64 { e.scallop_amt }
#[test_only]
public fun event_navi_amt(e: &PayrollEventV1): u64 { e.navi_amt }
#[test_only]
public fun event_period(e: &PayrollEventV1): u64 { e.period }
#[test_only]
public fun event_employee(e: &PayrollEventV1): address { e.employee }
#[test_only]
public fun event_jurisdiction(e: &PayrollEventV1): vector<u8> { e.jurisdiction }
#[test_only]
public fun event_fx_rate(e: &PayrollEventV1): u64 { e.fx_rate }
#[test_only]
public fun event_fx_stale(e: &PayrollEventV1): bool { e.fx_stale }

/// Build (without emitting) for field-wiring assertions. Mirrors the emit signature.
#[test_only]
public fun new_for_testing(
    payroll_id: ID,
    employer: address,
    employee: address,
    jurisdiction: vector<u8>,
    period: u64,
    gross: u64,
    withholding: u64,
    net: u64,
    liquid_amt: u64,
    scallop_amt: u64,
    navi_amt: u64,
    fx_pair: vector<u8>,
    fx_rate: u64,
    fx_pyth_publish_time: u64,
    fx_stale: bool,
): PayrollEventV1 {
    PayrollEventV1 {
        payroll_id, employer, employee, jurisdiction, period, gross, withholding, net,
        liquid_amt, scallop_amt, navi_amt, fx_pair, fx_rate, fx_pyth_publish_time, fx_stale,
    }
}
