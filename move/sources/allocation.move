/// Allocation (D3/D8/D10) — employee-controlled split of net pay across liquid / Scallop-yield /
/// Navi-BTC-index buckets, plus the `route()` splitter the payday path calls (spec §4/§5).
///
/// **Leaf module by design (mirrors escrow).** spec §5 lists `set_ratios`/`pause` taking
/// `&mut Payroll` + `&AllocationCap`, but `Payroll`/`EmployeeRecord` are defined in the `payroll`
/// module and the dependency direction is `payroll → allocation` (module-dependency.mmd). Importing
/// `Payroll` here would create a cycle, which Move forbids. So allocation exposes only
/// `public(package)` primitives over `AllocationConfig` (which is *stored inside* `EmployeeRecord`);
/// the cap-gated public wrappers (`set_ratios`, `pause`) live in `payroll` (TODO #5), which can see
/// the record, the `AllocationCap`, and the live `current_period`. allocation never references `Payroll`.
///
/// `AllocationConfig` carries the live ratios plus an optional `pending` staged change (D10
/// anti-frontrun). The effective period lives only on the staged change — committed ratios are always
/// live — so spec's redundant top-level `effective_from_period` is dropped (it belongs to `pending`).
///
/// `route()` is generic over the underlying coin `T` (matches the vault convention) and depends on the
/// concrete mock vault types; the mainnet swap replaces the mock module bodies while these signatures
/// stay fixed (spec §3.2/§12). No version field here: `AllocationConfig` is gated by the enclosing
/// `Payroll` object's own `assert_version` (D11) before any primitive below runs.
module payroll_flow::allocation;

use sui::coin::Coin;
use sui::clock::Clock;
use payroll_flow::mock_scallop::{Self, MockScallopVault};
use payroll_flow::mock_navi::{Self, MockNaviVault};

/// Basis-point denominator. All three bucket ratios must sum to exactly this.
const BPS_DENOM: u64 = 10000;

/// allocation bps != 10000. Matches the global E_RATIOS_SUM in spec §8.
const ERatiosSum: u64 = 4;

/// EMPLOYEE-owned authorization token (D3). Gates ratio mutation only — withdrawal is ownership-gated
/// at the vault layer, not by this cap (spec §6). `payroll_id` ties it to one payroll (D5: multi-employer
/// = multiple caps). Minted by `payroll::add_employee` and transferred to the employee.
public struct AllocationCap has key, store {
    id: UID,
    payroll_id: ID,
    employee: address,
}

/// A staged ratio change (D10). Promoted into the live `AllocationConfig` fields by `promote_if_due`
/// once `current_period >= effective_from_period`, i.e. no sooner than the payday *after* the change.
public struct PendingRatios has store, copy, drop {
    liquid_bps: u16,
    scallop_usdc_bps: u16,
    navi_btc_bps: u16,
    /// First period at which this change applies. Set to `current_period + 1` at stage time.
    effective_from_period: u64,
}

/// Per-employee split config, stored inside `payroll::EmployeeRecord` (D3: ratios live in the shared
/// `Payroll` so the employer-run payday can read them). The three live `*_bps` always sum to 10000.
public struct AllocationConfig has store, copy, drop {
    liquid_bps: u16,
    scallop_usdc_bps: u16,
    navi_btc_bps: u16,
    /// Staged change awaiting promotion (D10). `none` when no change is pending.
    pending: Option<PendingRatios>,
}

/// Mint an employee's `AllocationCap`. `public(package)`: only `payroll::add_employee` mints caps, so a
/// cap's existence always corresponds to a real `EmployeeRecord`.
public(package) fun new_cap(payroll_id: ID, employee: address, ctx: &mut TxContext): AllocationCap {
    AllocationCap { id: object::new(ctx), payroll_id, employee }
}

/// Default config for a new employee: 100% liquid, nothing staged. The employee later stages a real
/// split via the payroll-side `set_ratios` wrapper, effective next period.
public(package) fun default_config(): AllocationConfig {
    AllocationConfig {
        liquid_bps: (BPS_DENOM as u16),
        scallop_usdc_bps: 0,
        navi_btc_bps: 0,
        pending: option::none(),
    }
}

/// Stage a ratio change (D10). Validates the sum *now* (fail fast for the employee), but the change does
/// not take effect until `effective_from_period = current_period + 1` — so an employee cannot alter the
/// split of a payday already in flight. Overwrites any earlier un-promoted pending. `public(package)`:
/// the `payroll::set_ratios` wrapper checks `AllocationCap` ↔ record before calling.
public(package) fun stage_ratios(
    cfg: &mut AllocationConfig,
    current_period: u64,
    liquid_bps: u16,
    scallop_usdc_bps: u16,
    navi_btc_bps: u16,
) {
    assert_sum(liquid_bps, scallop_usdc_bps, navi_btc_bps);
    cfg.pending = option::some(PendingRatios {
        liquid_bps,
        scallop_usdc_bps,
        navi_btc_bps,
        effective_from_period: current_period + 1,
    });
}

/// Stage a one-shot "100% liquid next period" (spec §5 `pause`). Same anti-frontrun timing as `stage_ratios`.
public(package) fun stage_pause(cfg: &mut AllocationConfig, current_period: u64) {
    stage_ratios(cfg, current_period, (BPS_DENOM as u16), 0, 0);
}

/// Lazy per-record promotion (D10). If a pending change is due (`current_period >= effective_from_period`),
/// copy it into the live fields and clear it. Called by `pay_one` for the single record being paid — O(1),
/// no Table-wide sweep. Idempotent: a no-op when nothing is pending or it isn't due yet.
public(package) fun promote_if_due(cfg: &mut AllocationConfig, current_period: u64) {
    if (cfg.pending.is_some()) {
        let p = cfg.pending.borrow();
        if (current_period >= p.effective_from_period) {
            cfg.liquid_bps = p.liquid_bps;
            cfg.scallop_usdc_bps = p.scallop_usdc_bps;
            cfg.navi_btc_bps = p.navi_btc_bps;
            cfg.pending = option::none();
        };
    };
}

/// Split `net` into the three buckets and deposit per vault model, returning the **liquid remainder** for
/// the employee plus the **actually-deposited** scallop/navi amounts (for the truthful `PayrollEventV1`).
///
/// Liquid is the natural leftover coin — never an asserted sum — so value conservation
/// (`net == scallop + navi + liquid`) is structural via linear `Coin<T>`, and integer-division dust lands
/// in liquid (no overpay). D8 fallback: a paused vault is simply *not split out*, so its bucket stays in
/// `net` and is returned as liquid; the reported amount for that bucket is then 0, matching reality.
///
/// `public(package)`: only the payday path (`payroll::pay_one`) routes funds.
public(package) fun route<T>(
    net: Coin<T>,
    cfg: &AllocationConfig,
    scallop: &mut MockScallopVault<T>,
    navi: &mut MockNaviVault<T>,
    employee: address,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<T>, u64, u64) {
    let total = net.value();
    // Intended bucket amounts; u128 intermediate prevents overflow on large totals.
    let scallop_intended = (((total as u128) * (cfg.scallop_usdc_bps as u128) / (BPS_DENOM as u128)) as u64);
    let navi_intended = (((total as u128) * (cfg.navi_btc_bps as u128) / (BPS_DENOM as u128)) as u64);

    let mut net = net;
    let mut scallop_amt = 0;
    let mut navi_amt = 0;

    // Scallop bucket (receipt-coin model): mint sCoin, transfer the bearer claim to the employee.
    // D8: skip (fold into liquid) if the vault is paused. Guard amt>0 — mocks abort on zero deposit.
    if (scallop_intended > 0 && mock_scallop::is_active(scallop)) {
        let part = net.split(scallop_intended, ctx);
        let receipt = mock_scallop::mint(scallop, part, clock, ctx);
        transfer::public_transfer(receipt, employee);
        scallop_amt = scallop_intended;
    };

    // Navi bucket (address-keyed model): deposit credits the employee directly (no return value).
    if (navi_intended > 0 && mock_navi::is_active(navi)) {
        let part = net.split(navi_intended, ctx);
        mock_navi::deposit(navi, employee, part, clock);
        navi_amt = navi_intended;
    };

    // Remainder = liquid (intended liquid + rounding dust + any paused-vault fallback).
    (net, scallop_amt, navi_amt)
}

/// Assert the three bps sum to exactly 10000.
fun assert_sum(liquid_bps: u16, scallop_usdc_bps: u16, navi_btc_bps: u16) {
    let sum = (liquid_bps as u64) + (scallop_usdc_bps as u64) + (navi_btc_bps as u64);
    assert!(sum == BPS_DENOM, ERatiosSum);
}

// --- accessors (read by the payroll wrapper for cap↔record checks and by views) ---

public fun cap_payroll_id(cap: &AllocationCap): ID { cap.payroll_id }
public fun cap_employee(cap: &AllocationCap): address { cap.employee }

public fun liquid_bps(cfg: &AllocationConfig): u16 { cfg.liquid_bps }
public fun scallop_usdc_bps(cfg: &AllocationConfig): u16 { cfg.scallop_usdc_bps }
public fun navi_btc_bps(cfg: &AllocationConfig): u16 { cfg.navi_btc_bps }
public fun has_pending(cfg: &AllocationConfig): bool { cfg.pending.is_some() }

/// Effective period of the staged change, if any (for views / tests).
public fun pending_effective_period(cfg: &AllocationConfig): Option<u64> {
    if (cfg.pending.is_some()) {
        option::some(cfg.pending.borrow().effective_from_period)
    } else { option::none() }
}

#[test_only]
public fun new_cap_for_testing(payroll_id: ID, employee: address, ctx: &mut TxContext): AllocationCap {
    new_cap(payroll_id, employee, ctx)
}

#[test_only]
public fun default_config_for_testing(): AllocationConfig { default_config() }
