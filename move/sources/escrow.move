/// Tax escrow (D6) — a single shared object holding employer-side tax withholding,
/// segregated per jurisdiction in `Table<jurisdiction, Balance<T>>` (spec §4/§5/§6).
///
/// **Leaf module by design.** spec §5 lists `remit`/`migrate` taking `&PayrollOwnerCap`,
/// but that cap is defined in the `payroll` module and the dependency direction is
/// `payroll → escrow` (see module-dependency.mmd). Importing the cap here would create a
/// cycle, which Move forbids. So escrow exposes only `public(package)` primitives
/// (`reserve` / `withdraw` / `migrate` / `assert_version`); the cap-gated public wrappers
/// (`remit`, `migrate`) live in the `payroll` module (TODO #5), which can see both the cap
/// and this object. escrow itself never references any capability.
///
/// Generic over the underlying coin `T` to match the existing vault convention (vaults are
/// all `<T>`); at GTM `T` is instantiated with the canonical mainnet USDC type. spec hardcodes
/// `USDC`, but there is no production USDC type yet, so generic keeps the swap a type-arg change.
///
/// D11 upgrade gate: `version` + `assert_version` on every mutating entry. After a package
/// upgrade, the employer calls the payroll-side `migrate` wrapper which bumps this object's
/// `version` to the new package `VERSION`, fencing the old module version off.
module payroll_flow::escrow;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::table::{Self, Table};

/// Current package version for the D11 upgrade gate. Bumped on every upgrade that ships a
/// `migrate`. Mirrored by the `Payroll` object's own VERSION (each shared object gates itself).
const VERSION: u64 = 1;

/// D11: object `version` != package `VERSION` (stale module post-upgrade). Code 9 matches the
/// global E_WRONG_VERSION in spec §8 so cross-document references stay aligned.
const EWrongVersion: u64 = 9;
/// `migrate` called when the object is already at (or past) the current `VERSION`.
const ENotUpgrade: u64 = 10;
/// `withdraw` for a jurisdiction that has never been reserved into. Module-local (100+) like the
/// mock vaults, to avoid colliding with the payroll-global codes in spec §8.
const EUnknownJurisdiction: u64 = 101;
/// `withdraw` amount exceeds the jurisdiction's escrowed balance.
const EInsufficientEscrow: u64 = 102;

/// Single shared escrow object (D6). One per coin type `T`.
public struct TaxEscrow<phantom T> has key {
    id: UID,
    /// D11 upgrade gate; checked by `assert_version` on every mutating entry.
    version: u64,
    /// Segregated float per jurisdiction key (e.g. b"AR", b"US-1099"). Revenue line §10.2 reads this.
    by_jurisdiction: Table<vector<u8>, Balance<T>>,
}

/// Create an unshared escrow at the current `VERSION`. Caller (payroll::create_payroll) shares it
/// via `share` in the same PTB. Kept `public(package)` so only in-package code mints escrows.
public(package) fun new<T>(ctx: &mut TxContext): TaxEscrow<T> {
    TaxEscrow<T> {
        id: object::new(ctx),
        version: VERSION,
        by_jurisdiction: table::new<vector<u8>, Balance<T>>(ctx),
    }
}

/// Share the escrow. `share_object` is restricted to the defining module for a `key`-only type,
/// so this helper exists for callers in other in-package modules.
public(package) fun share<T>(escrow: TaxEscrow<T>) {
    transfer::share_object(escrow);
}

/// Reserve employer-side withholding into the jurisdiction bucket. Called by `payroll::pay_one`
/// with an already-split `Balance<T>` (value conservation is enforced upstream by the linear
/// split). A zero balance is allowed (0% withholding jurisdictions, e.g. some 1099). `public(package)`:
/// only payday code may write buckets, preventing arbitrary callers from polluting jurisdiction keys.
public(package) fun reserve<T>(escrow: &mut TaxEscrow<T>, jurisdiction: vector<u8>, amt: Balance<T>) {
    assert_version(escrow);
    if (escrow.by_jurisdiction.contains(jurisdiction)) {
        escrow.by_jurisdiction.borrow_mut(jurisdiction).join(amt);
    } else {
        escrow.by_jurisdiction.add(jurisdiction, amt);
    };
}

/// Withdraw `amount` from a jurisdiction bucket as a `Coin<T>`. Auth is the caller's
/// responsibility: the `payroll::remit` wrapper checks `&PayrollOwnerCap` before calling this.
/// `public(package)` so it is unreachable from outside the package.
public(package) fun withdraw<T>(
    escrow: &mut TaxEscrow<T>,
    jurisdiction: vector<u8>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert_version(escrow);
    assert!(escrow.by_jurisdiction.contains(jurisdiction), EUnknownJurisdiction);
    let bucket = escrow.by_jurisdiction.borrow_mut(jurisdiction);
    assert!(bucket.value() >= amount, EInsufficientEscrow);
    coin::take(bucket, amount, ctx)
}

/// D11 migrate: bump the object's `version` to the current package `VERSION`. The `payroll::migrate`
/// wrapper checks `&PayrollOwnerCap` first. Aborts if already current (one-shot per upgrade).
public(package) fun migrate<T>(escrow: &mut TaxEscrow<T>) {
    assert!(escrow.version < VERSION, ENotUpgrade);
    escrow.version = VERSION;
}

/// D11 gate: abort if the object's version doesn't match the running package `VERSION`.
public(package) fun assert_version<T>(escrow: &TaxEscrow<T>) {
    assert!(escrow.version == VERSION, EWrongVersion);
}

// --- views ---

/// Escrowed balance for a jurisdiction (0 if never reserved). Feeds revenue line §10.2 / auditor view.
public fun balance_of<T>(escrow: &TaxEscrow<T>, jurisdiction: vector<u8>): u64 {
    if (escrow.by_jurisdiction.contains(jurisdiction)) {
        escrow.by_jurisdiction.borrow(jurisdiction).value()
    } else { 0 }
}

public fun version<T>(escrow: &TaxEscrow<T>): u64 { escrow.version }

#[test_only]
public fun package_version(): u64 { VERSION }

#[test_only]
public fun new_for_testing<T>(ctx: &mut TxContext): TaxEscrow<T> { new<T>(ctx) }

#[test_only]
/// Force an object's version for D11 testing (simulates a pre-upgrade stale object).
public fun set_version_for_testing<T>(escrow: &mut TaxEscrow<T>, v: u64) { escrow.version = v; }
