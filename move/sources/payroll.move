/// Payroll (spec §4/§5/§6) — the root module that owns the shared `Payroll` registry and is the
/// **single place every capability is checked**. The three leaf modules (escrow / allocation /
/// compliance) expose only `public(package)` primitives with no auth; payroll is the only module that
/// can see `PayrollOwnerCap`, `AllocationCap`, `EmployeeRecord`, and the live `current_period` together,
/// so all capability gating and the cap↔record auth that #2/#3 deferred ("⚠ HIGH 約束轉 #5") collapses
/// to two assertions here: `assert_owner` and `assert_alloc_owner`.
///
/// **3 spec-literal deviations (mirror the approved #2/#3 deviations):**
/// 1. `Payroll<phantom T>` is generic over the coin type. spec hardcodes `Balance<USDC>`, but escrow,
///    allocation, and the vaults are all `<T>` and there is no production USDC type yet — generic keeps
///    the GTM swap a type-arg change (matches escrow's rationale verbatim).
/// 2. FX is a scalar seam, not `&PythPrice`. Pyth is TODO #7 (not yet integrated). `pay_one` takes
///    `(fx_pair, fx_rate, fx_pyth_publish_time, clock)` and derives `fx_stale` (D9) in-module; TODO #7
///    wraps Pyth into these scalars without changing this signature.
/// 3. `add_employee` transfers the minted `AllocationCap` to the employee (spec returns it) — entry-friendly.
///
/// Value conservation is structural via linear `Balance<T>`/`Coin<T>`: `funding.split(gross)` →
/// `.split(withholding)` → `route(net)`. No amount is ever conjured; compliance's u128 sum-check is a
/// fail-loud backstop (Rule 12), not the primary guarantee.
module payroll_flow::payroll;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::clock::Clock;
use sui::table::{Self, Table};
use payroll_flow::allocation::{Self, AllocationConfig, AllocationCap};
use payroll_flow::escrow::{Self, TaxEscrow};
use payroll_flow::compliance;
use payroll_flow::mock_scallop::MockScallopVault;
use payroll_flow::mock_navi::MockNaviVault;

/// Current package version for the D11 upgrade gate. Bumped on every upgrade that ships a `migrate`.
/// Mirrors `escrow::VERSION` — each shared object gates itself.
const VERSION: u64 = 1;

/// Basis-point denominator for withholding.
const BPS_DENOM: u64 = 10000;

/// D9: FX older than this (ms) is flagged `fx_stale` in the event — never aborts (reporting-only).
const FX_STALE_MS: u64 = 60_000;

// --- error codes (spec §8) ---
/// `PayrollOwnerCap` does not authorize this `Payroll`.
const ENotOwner: u64 = 1;
/// `AllocationCap` does not match the target `EmployeeRecord`.
const ENotAllocationOwner: u64 = 2;
/// payday pool < gross for this employee.
const EInsufficientFunding: u64 = 3;
/// `withholding_bps` > 10000.
const EWithholdingRange: u64 = 5;
/// no `EmployeeRecord` for the address.
const EUnknownEmployee: u64 = 7;
/// D11: object `version` != package `VERSION` (stale module post-upgrade).
const EWrongVersion: u64 = 9;
/// `migrate` called when already at (or past) the current `VERSION`. Mirrors `escrow::ENotUpgrade`.
const ENotUpgrade: u64 = 10;
/// `pay_one` called twice for the same employee within one period (no intervening `begin_period`).
/// On-chain double-pay backstop — orchestrator discipline alone is not trusted (Rule 12, fail-loud).
const EAlreadyPaidThisPeriod: u64 = 11;
/// A `TaxEscrow<T>` was passed that is not the one bound to this `Payroll` at creation. Closes the
/// #2-deferred HIGH: the owner cap gates *who* calls, this gates *which escrow* (cross-tenant drain).
const EWrongEscrow: u64 = 12;

/// Shared payroll registry (D3/D4). One per employer (MVP single-employer; multi = multiple objects).
public struct Payroll<phantom T> has key {
    id: UID,
    /// D11 upgrade gate; checked by `assert_version` on every mutating entry.
    version: u64,
    /// The `PayrollOwnerCap` authorized to mutate this object (employer 2-of-N multisig holds it).
    owner_cap_id: ID,
    /// The `TaxEscrow<T>` created alongside this payroll. `pay_one`/`remit`/`migrate` assert the escrow
    /// arg matches this, so a valid owner cap cannot route into / drain another tenant's escrow (D5/D6
    /// multi-employer: many escrows of the same `T` coexist). Vaults are intentionally NOT bound — at GTM
    /// Scallop/Navi are global singletons every payroll shares.
    escrow_id: ID,
    /// Employer-funded payday pool. `pay_one` splits each employee's gross out of this.
    funding: Balance<T>,
    /// Per-employee records, address-keyed (D4).
    employees: Table<address, EmployeeRecord>,
    /// D10 payday counter; bumped once per payday by `begin_period`; allocation staging key.
    current_period: u64,
}

/// Per-employee record stored inside the shared `Payroll` (D3: ratios live shared so the employer-run
/// payday can read them).
public struct EmployeeRecord has store {
    employee: address,
    jurisdiction: vector<u8>,
    gross: u64,
    withholding_bps: u16,
    allocation: AllocationConfig,
    /// The `AllocationCap` (by object id) authorized to mutate `allocation`.
    allocation_cap_id: ID,
    /// Last period this employee was paid (D10 idempotency). `pay_one` requires `< current_period`, so an
    /// employee is paid at most once per payday even if the orchestrator replays the PTB. 0 = never paid.
    last_paid_period: u64,
    active: bool,
}

/// Employer capability (held by a 2-of-N multisig address; multisig enforced at the Sui account layer).
public struct PayrollOwnerCap has key, store {
    id: UID,
    payroll_id: ID,
}

/// Create a payroll + its tax escrow, share both, and send the owner cap to the caller (the employer).
/// `Payroll`/`TaxEscrow` are `key`-only so they must be shared by their defining modules — done here.
#[allow(lint(self_transfer))] // the employer running create_payroll is the intended cap holder
public fun create_payroll<T>(ctx: &mut TxContext) {
    let escrow = escrow::new<T>(ctx);
    let escrow_id = object::id(&escrow);
    let mut payroll = Payroll<T> {
        id: object::new(ctx),
        version: VERSION,
        owner_cap_id: object::id_from_address(@0x0), // placeholder; set below once the cap exists
        escrow_id,
        funding: balance::zero<T>(),
        employees: table::new<address, EmployeeRecord>(ctx),
        current_period: 0,
    };
    let cap = PayrollOwnerCap { id: object::new(ctx), payroll_id: object::id(&payroll) };
    payroll.owner_cap_id = object::id(&cap);

    escrow::share(escrow);
    transfer::share_object(payroll);
    transfer::public_transfer(cap, ctx.sender());
}

/// Add USDC to the payday pool. Owner-gated.
public fun fund<T>(payroll: &mut Payroll<T>, cap: &PayrollOwnerCap, c: Coin<T>) {
    assert_version(payroll);
    assert_owner(payroll, cap);
    payroll.funding.join(c.into_balance());
}

/// Register an employee: mints their `AllocationCap`, stores the record (default 100% liquid), and sends
/// the cap to the employee. Owner-gated. `withholding_bps ≤ 10000` (spec §8 E_WITHHOLDING_RANGE).
public fun add_employee<T>(
    payroll: &mut Payroll<T>,
    cap: &PayrollOwnerCap,
    employee: address,
    jurisdiction: vector<u8>,
    gross: u64,
    withholding_bps: u16,
    ctx: &mut TxContext,
) {
    assert_version(payroll);
    assert_owner(payroll, cap);
    assert!((withholding_bps as u64) <= BPS_DENOM, EWithholdingRange);

    let payroll_id = object::id(payroll);
    let alloc_cap = allocation::new_cap(payroll_id, employee, ctx);
    let record = EmployeeRecord {
        employee,
        jurisdiction,
        gross,
        withholding_bps,
        allocation: allocation::default_config(),
        allocation_cap_id: object::id(&alloc_cap),
        last_paid_period: 0,
        active: true,
    };
    payroll.employees.add(employee, record);
    transfer::public_transfer(alloc_cap, employee);
}

/// Update an employee's per-period gross. Owner-gated.
public fun set_gross<T>(payroll: &mut Payroll<T>, cap: &PayrollOwnerCap, employee: address, gross: u64) {
    assert_version(payroll);
    assert_owner(payroll, cap);
    assert!(payroll.employees.contains(employee), EUnknownEmployee);
    payroll.employees.borrow_mut(employee).gross = gross;
}

/// D10: bump `current_period` exactly once per payday, before the first `pay_one` of the run. Owner-gated.
public fun begin_period<T>(payroll: &mut Payroll<T>, cap: &PayrollOwnerCap) {
    assert_version(payroll);
    assert_owner(payroll, cap);
    payroll.current_period = payroll.current_period + 1;
}

/// Employee stages a ratio change (D10) — effective next period. Gated by the employee's `AllocationCap`.
public fun set_ratios<T>(
    payroll: &mut Payroll<T>,
    cap: &AllocationCap,
    employee: address,
    liquid_bps: u16,
    scallop_usdc_bps: u16,
    navi_btc_bps: u16,
) {
    assert_version(payroll);
    let cur = payroll.current_period;
    let pid = object::id(payroll);
    let record = borrow_record_for_cap(payroll, cap, employee, pid);
    allocation::stage_ratios(&mut record.allocation, cur, liquid_bps, scallop_usdc_bps, navi_btc_bps);
}

/// Employee stages a one-cycle "100% liquid" (spec §5 `pause`). Gated by the employee's `AllocationCap`.
public fun pause<T>(payroll: &mut Payroll<T>, cap: &AllocationCap, employee: address) {
    assert_version(payroll);
    let cur = payroll.current_period;
    let pid = object::id(payroll);
    let record = borrow_record_for_cap(payroll, cap, employee, pid);
    allocation::stage_pause(&mut record.allocation, cur);
}

/// One per-employee branch of the payday PTB. Pure value-conserving split (spec §5):
/// gross → withholding (to escrow) + net → routed buckets + liquid (to employee), then a `PayrollEventV1`.
/// Aborts the whole PTB only on funding shortfall or unknown/inactive employee — never on vault outage (D8,
/// handled inside `route`) or stale FX (D9, flagged not aborted). Owner-gated.
public fun pay_one<T>(
    payroll: &mut Payroll<T>,
    cap: &PayrollOwnerCap,
    escrow: &mut TaxEscrow<T>,
    scallop: &mut MockScallopVault<T>,
    navi: &mut MockNaviVault<T>,
    employee: address,
    fx_pair: vector<u8>,
    fx_rate: u64,
    fx_pyth_publish_time: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_version(payroll);
    assert_owner(payroll, cap);
    assert!(object::id(escrow) == payroll.escrow_id, EWrongEscrow);
    assert!(payroll.employees.contains(employee), EUnknownEmployee);

    let period = payroll.current_period;
    let payroll_id = object::id(payroll);
    let employer = ctx.sender();

    // Read + promote the record under one borrow, then copy out everything the value path needs so the
    // `employees` borrow ends before we touch `payroll.funding` (disjoint-field borrow hygiene).
    let record = payroll.employees.borrow_mut(employee);
    assert!(record.active, EUnknownEmployee);
    // D10 idempotency: at most one payment per employee per period. Requires period ≥ 1, i.e. a
    // `begin_period` must have opened this payday before anyone is paid.
    assert!(record.last_paid_period < period, EAlreadyPaidThisPeriod);
    record.last_paid_period = period;
    allocation::promote_if_due(&mut record.allocation, period);
    let gross = record.gross;
    let withholding_bps = record.withholding_bps;
    let jurisdiction = record.jurisdiction;
    let cfg = record.allocation; // AllocationConfig has `copy`

    // Linear split chain — value conservation is structural.
    assert!(payroll.funding.value() >= gross, EInsufficientFunding);
    let mut gross_bal = payroll.funding.split(gross);
    let withholding = (((gross as u128) * (withholding_bps as u128) / (BPS_DENOM as u128)) as u64);
    let wh_bal = gross_bal.split(withholding);
    escrow::reserve(escrow, jurisdiction, wh_bal);

    let net_coin = coin::from_balance(gross_bal, ctx);
    let net = net_coin.value();
    let (liquid_coin, scallop_amt, navi_amt) =
        allocation::route(net_coin, &cfg, scallop, navi, employee, clock, ctx);
    let liquid_amt = liquid_coin.value();
    transfer::public_transfer(liquid_coin, employee);

    let fx_stale = is_fx_stale(clock, fx_pyth_publish_time);
    compliance::emit_payroll_event_v1(
        payroll_id, employer, employee, jurisdiction, period,
        gross, withholding, net,
        liquid_amt, scallop_amt, navi_amt,
        fx_pair, fx_rate, fx_pyth_publish_time, fx_stale,
    );
}

/// Remit escrowed withholding to a tax authority (spec §5). Owner-gated; binds cap→payroll→escrow<T> so
/// no unauthorized caller can drain the escrow (the HIGH constraint deferred from #2).
public fun remit<T>(
    payroll: &Payroll<T>,
    cap: &PayrollOwnerCap,
    escrow: &mut TaxEscrow<T>,
    jurisdiction: vector<u8>,
    amount: u64,
    to: address,
    ctx: &mut TxContext,
) {
    assert_version(payroll);
    assert_owner(payroll, cap);
    assert!(object::id(escrow) == payroll.escrow_id, EWrongEscrow);
    let coin = escrow::withdraw(escrow, jurisdiction, amount, ctx);
    transfer::public_transfer(coin, to);
}

/// D11 one-shot migrate after a package upgrade: bumps both the `Payroll` and `TaxEscrow` versions to the
/// new package `VERSION`. Owner-gated; aborts if `Payroll` is already current.
public fun migrate<T>(payroll: &mut Payroll<T>, cap: &PayrollOwnerCap, escrow: &mut TaxEscrow<T>) {
    // Check ownership against the CURRENT object state before bumping.
    assert_owner(payroll, cap);
    assert!(object::id(escrow) == payroll.escrow_id, EWrongEscrow);
    assert!(payroll.version < VERSION, ENotUpgrade);
    payroll.version = VERSION;
    escrow::migrate(escrow);
}

// --- internal auth + helpers ---

/// Both directions: the cap's id must be the one this payroll records, AND the cap must name this payroll.
fun assert_owner<T>(payroll: &Payroll<T>, cap: &PayrollOwnerCap) {
    assert!(object::id(cap) == payroll.owner_cap_id, ENotOwner);
    assert!(cap.payroll_id == object::id(payroll), ENotOwner);
}

/// Resolve the record for `employee` and assert the `AllocationCap` is the one bound to it: same object id,
/// same employee, same payroll. Returns a mutable borrow for staging.
fun borrow_record_for_cap<T>(
    payroll: &mut Payroll<T>,
    cap: &AllocationCap,
    employee: address,
    payroll_id: ID,
): &mut EmployeeRecord {
    assert!(allocation::cap_payroll_id(cap) == payroll_id, ENotAllocationOwner);
    assert!(allocation::cap_employee(cap) == employee, ENotAllocationOwner);
    assert!(payroll.employees.contains(employee), EUnknownEmployee);
    let record = payroll.employees.borrow_mut(employee);
    assert!(record.allocation_cap_id == object::id(cap), ENotAllocationOwner);
    record
}

/// D9: FX is stale if the Pyth publish time is more than 60s behind the clock. Never aborts — the result
/// only sets the event's `fx_stale` flag. `fx_pyth_publish_time` is in ms (TODO #7 must pass ms).
fun is_fx_stale(clock: &Clock, fx_pyth_publish_time: u64): bool {
    let now = clock.timestamp_ms();
    now > fx_pyth_publish_time && (now - fx_pyth_publish_time) > FX_STALE_MS
}

/// D11 gate: abort if the object's version doesn't match the running package `VERSION`.
fun assert_version<T>(payroll: &Payroll<T>) {
    assert!(payroll.version == VERSION, EWrongVersion);
}

// --- views ---

public fun version<T>(payroll: &Payroll<T>): u64 { payroll.version }
public fun current_period<T>(payroll: &Payroll<T>): u64 { payroll.current_period }
public fun funding_value<T>(payroll: &Payroll<T>): u64 { payroll.funding.value() }
public fun owner_cap_id<T>(payroll: &Payroll<T>): ID { payroll.owner_cap_id }
public fun has_employee<T>(payroll: &Payroll<T>, employee: address): bool {
    payroll.employees.contains(employee)
}
public fun employee_gross<T>(payroll: &Payroll<T>, employee: address): u64 {
    payroll.employees.borrow(employee).gross
}
public fun employee_active<T>(payroll: &Payroll<T>, employee: address): bool {
    payroll.employees.borrow(employee).active
}
public fun cap_payroll_id(cap: &PayrollOwnerCap): ID { cap.payroll_id }

#[test_only]
/// Mirrors `create_payroll`: creates + shares both the `Payroll` and its bound `TaxEscrow<T>`, returns
/// the owner cap to the caller. Tests `take_shared` the escrow rather than minting their own (which would
/// fail the new `escrow_id` bind).
public fun create_payroll_for_testing<T>(ctx: &mut TxContext): PayrollOwnerCap {
    let escrow = escrow::new<T>(ctx);
    let escrow_id = object::id(&escrow);
    let mut payroll = Payroll<T> {
        id: object::new(ctx),
        version: VERSION,
        owner_cap_id: object::id_from_address(@0x0),
        escrow_id,
        funding: balance::zero<T>(),
        employees: table::new<address, EmployeeRecord>(ctx),
        current_period: 0,
    };
    let cap = PayrollOwnerCap { id: object::new(ctx), payroll_id: object::id(&payroll) };
    payroll.owner_cap_id = object::id(&cap);
    escrow::share(escrow);
    transfer::share_object(payroll);
    cap
}

#[test_only]
public fun set_version_for_testing<T>(payroll: &mut Payroll<T>, v: u64) { payroll.version = v; }

#[test_only]
public fun package_version(): u64 { VERSION }
