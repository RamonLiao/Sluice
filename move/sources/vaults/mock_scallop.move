/// Mock Scallop vault — **receipt-coin model** (spec §3.1/§3.3).
///
/// Mirrors `protocol::mint::mint<T>(...) : Coin<MarketCoin<T>>`: a deposit returns a
/// bearer receipt coin (`MockSCoin<T>`) that is PTB-composable and whose holder *is* the
/// claim. The receipt appreciates against the underlying via an exchange-rate accumulator
/// that ticks with the `Clock`, mirroring `MarketCoin` semantics. This is NOT a stub: real
/// `Balance<T>` reserves move, real receipt supply is minted/burned, value is conserved.
///
/// Mainnet swap (spec §12): replace this module's body with real Scallop `protocol::mint`
/// calls (non-entry, returns sCoin) while keeping the `mint`/`redeem` signatures. `route()`
/// is untouched.
module payroll_flow::mock_scallop;

use sui::balance::{Self, Balance, Supply};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use payroll_flow::vault_std;

/// Receipt-coin marker. `Coin<MockSCoin<T>>` is the bearer claim on a `T` position,
/// analogous to Scallop's `MarketCoin<T>`. `phantom` because no `T` value is stored in it.
public struct MockSCoin<phantom T> has drop {}

/// Index fixed-point scale (1e9). `index` is underlying-per-share; starts at SCALE so the
/// first deposit mints 1:1 shares, then grows over time so redemption returns principal + yield.
const SCALE: u128 = 1_000_000_000;

/// Shared vault, one per underlying type `T`.
public struct MockScallopVault<phantom T> has key {
    id: UID,
    reserves: Balance<T>,
    receipt_supply: Supply<MockSCoin<T>>,
    /// underlying-per-share, scaled by SCALE. Monotonically non-decreasing.
    index: u128,
    /// index growth per second, scaled by SCALE (e.g. SCALE/1_000_000 ≈ ~3%/yr demo drift).
    rate_per_sec: u128,
    /// last clock ms at which `index` was accrued.
    last_ts_ms: u64,
    /// D8 liveness flag; `route()` reads this to fall back to liquid when paused.
    active: bool,
}

/// Per-vault admin token (demo operator) — `set_active` for the outage demo only.
/// Not part of the mainnet adapter (spec §6).
public struct AdminCap has key, store {
    id: UID,
    vault_id: ID,
}

const ENotAdmin: u64 = 1;
const EZeroDeposit: u64 = 2;
const EZeroRedeem: u64 = 3;

/// Create + share an empty vault for underlying `T`; returns the demo `AdminCap` to caller.
/// `rate_per_sec` is the appreciation drift (scaled by SCALE).
public fun create<T>(rate_per_sec: u128, clock: &Clock, ctx: &mut TxContext): AdminCap {
    let vault = MockScallopVault<T> {
        id: object::new(ctx),
        reserves: balance::zero<T>(),
        receipt_supply: balance::create_supply(MockSCoin<T> {}),
        index: SCALE,
        rate_per_sec,
        last_ts_ms: clock.timestamp_ms(),
        active: true,
    };
    let cap = AdminCap { id: object::new(ctx), vault_id: object::id(&vault) };
    transfer::share_object(vault);
    cap
}

/// Accrue the exchange-rate index up to `now`. Linear drift: index += rate_per_sec * elapsed_s.
fun accrue<T>(vault: &mut MockScallopVault<T>, clock: &Clock) {
    let now = clock.timestamp_ms();
    if (now > vault.last_ts_ms) {
        let elapsed_s = ((now - vault.last_ts_ms) / 1000) as u128;
        if (elapsed_s > 0) {
            vault.index = vault.index + vault.rate_per_sec * elapsed_s;
            vault.last_ts_ms = now;
        };
    };
}

/// Scallop-shaped deposit. Moves `coin` into reserves, mints appreciating receipt coin.
/// shares = value * SCALE / index (index ≥ SCALE ⇒ shares ≤ value, room for appreciation).
/// Router transfers the returned receipt to the employee; holding it IS the claim.
public fun mint<T>(
    vault: &mut MockScallopVault<T>,
    coin: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<MockSCoin<T>> {
    vault_std::assert_active(vault.active);
    accrue(vault, clock);
    let value = coin.value();
    assert!(value > 0, EZeroDeposit);
    let shares = ((value as u128) * SCALE / vault.index) as u64;
    vault.reserves.join(coin.into_balance());
    let receipt = vault.receipt_supply.increase_supply(shares);
    coin::from_balance(receipt, ctx)
}

/// Burn the receipt, return principal + accrued yield. underlying = shares * index / SCALE.
/// Bearer model: whoever holds the receipt redeems it (spec §6, withdrawal not cap-gated).
public fun redeem<T>(
    vault: &mut MockScallopVault<T>,
    receipt: Coin<MockSCoin<T>>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    vault_std::assert_active(vault.active);
    accrue(vault, clock);
    let shares = receipt.value();
    assert!(shares > 0, EZeroRedeem);
    let underlying = ((shares as u128) * vault.index / SCALE) as u64;
    vault.receipt_supply.decrease_supply(receipt.into_balance());
    coin::take(&mut vault.reserves, underlying, ctx)
}

/// D8 outage demo: pause/unpause. Admin-gated.
public fun set_active<T>(cap: &AdminCap, vault: &mut MockScallopVault<T>, active: bool) {
    assert!(cap.vault_id == object::id(vault), ENotAdmin);
    vault.active = active;
}

// --- views ---
public fun is_active<T>(vault: &MockScallopVault<T>): bool { vault.active }
public fun index<T>(vault: &MockScallopVault<T>): u128 { vault.index }
public fun reserves_value<T>(vault: &MockScallopVault<T>): u64 { vault.reserves.value() }
