/// Mock Navi vault — **account/address-keyed model** (spec §3.1/§3.3).
///
/// Mirrors Navi `lending_core` deposit semantics: the call returns NOTHING; the position
/// is recorded in an address-keyed table (mirrors `TokenBalance.user_state: Table<address,
/// u256>`). Critically, real Navi credits the **tx sender**; payday's sender is the employer,
/// which would violate "employers never custody employee yield" (spec §3.1, BUSINESS_SPEC §6.2).
/// So this mock takes an explicit `beneficiary: address` and credits the employee directly,
/// faithfully mirroring Navi's underlying ledger while fixing the custody seam.
///
/// `index_price` acts as the BTC-index proxy (BUSINESS_SPEC §7 MVP).
///
/// Mainnet swap (spec §12, OPEN task): real Navi needs a per-employee `AccountCap` or a
/// sponsored/co-signed deposit to credit a beneficiary other than the sender. Tracked in
/// move-notes.md before GTM.
module payroll_flow::mock_navi;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::table::{Self, Table};
use payroll_flow::vault_std;

/// Shared vault, one per underlying type `T`.
public struct MockNaviVault<phantom T> has key {
    id: UID,
    reserves: Balance<T>,
    /// address-keyed positions, mirrors Navi `TokenBalance.user_state`.
    positions: Table<address, u128>,
    /// BTC-index proxy price (BUSINESS_SPEC §7). Informational for the mock.
    index_price: u64,
    /// D8 liveness flag.
    active: bool,
}

/// Per-vault admin token (demo operator) — `set_active` / `set_index_price` for demo only.
public struct AdminCap has key, store {
    id: UID,
    vault_id: ID,
}

const ENotAdmin: u64 = 1;
const EZeroDeposit: u64 = 2;
const EVaultPrincipal: u64 = 8; // matches spec §8 E_VAULT_PRINCIPAL: withdraw exceeds recorded position
const ENoPosition: u64 = 9;

/// Create + share an empty vault for underlying `T`; returns the demo `AdminCap`.
public fun create<T>(index_price: u64, ctx: &mut TxContext): AdminCap {
    let vault = MockNaviVault<T> {
        id: object::new(ctx),
        reserves: balance::zero<T>(),
        positions: table::new<address, u128>(ctx),
        index_price,
        active: true,
    };
    let cap = AdminCap { id: object::new(ctx), vault_id: object::id(&vault) };
    transfer::share_object(vault);
    cap
}

/// Navi-shaped deposit: NO return value; credits `beneficiary` in the address-keyed table.
/// `clock` kept in the signature for interface fidelity (real Navi accrues on deposit).
public fun deposit<T>(
    vault: &mut MockNaviVault<T>,
    beneficiary: address,
    coin: Coin<T>,
    _clock: &Clock,
) {
    vault_std::assert_active(vault.active);
    let value = coin.value();
    assert!(value > 0, EZeroDeposit);
    vault.reserves.join(coin.into_balance());
    if (vault.positions.contains(beneficiary)) {
        let p = vault.positions.borrow_mut(beneficiary);
        *p = *p + (value as u128);
    } else {
        vault.positions.add(beneficiary, value as u128);
    };
}

/// Address-keyed withdrawal: pays out against `positions[sender]` only — the position
/// holder is the only one who can withdraw (spec §6, ownership-gated, not cap-gated).
public fun withdraw<T>(
    vault: &mut MockNaviVault<T>,
    amount: u64,
    _clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    vault_std::assert_active(vault.active);
    let sender = ctx.sender();
    assert!(vault.positions.contains(sender), ENoPosition);
    let p = vault.positions.borrow_mut(sender);
    assert!(*p >= (amount as u128), EVaultPrincipal);
    *p = *p - (amount as u128);
    coin::take(&mut vault.reserves, amount, ctx)
}

/// D8 outage demo: pause/unpause. Admin-gated.
public fun set_active<T>(cap: &AdminCap, vault: &mut MockNaviVault<T>, active: bool) {
    assert!(cap.vault_id == object::id(vault), ENotAdmin);
    vault.active = active;
}

/// Update the BTC-index proxy price. Admin-gated.
public fun set_index_price<T>(cap: &AdminCap, vault: &mut MockNaviVault<T>, price: u64) {
    assert!(cap.vault_id == object::id(vault), ENotAdmin);
    vault.index_price = price;
}

// --- views ---
public fun is_active<T>(vault: &MockNaviVault<T>): bool { vault.active }
public fun index_price<T>(vault: &MockNaviVault<T>): u64 { vault.index_price }
public fun position_of<T>(vault: &MockNaviVault<T>, who: address): u128 {
    if (vault.positions.contains(who)) *vault.positions.borrow(who) else 0
}
public fun reserves_value<T>(vault: &MockNaviVault<T>): u64 { vault.reserves.value() }
