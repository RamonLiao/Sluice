# PayrollFlow — System Architecture Spec

> Track 1 · DeFi & Payments · Sui Overflow 2026
> Spec date: 2026-05-30 · Protocol 124 (testnet v1.72.2) · SDK `@mysten/sui`
> Source business spec: [`BUSINESS_SPEC.md`](../../BUSINESS_SPEC.md)

---

## 0. Locked Architecture Decisions

These resolve the open questions in `BUSINESS_SPEC.md §14` and a latent contradiction in `§9`.
They are the binding contract for implementation; deviating requires re-opening the decision.

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Yield vault integration (MVP) | **Mock vaults on testnet, mirroring real mainnet contract interfaces** | Scallop has **no testnet** (SDK is mainnet-only); Navi testnet is unverified/unstable. Routing live demo funds into external mainnet protocols binds demo success to their uptime (`BUSINESS_SPEC §13`). Mock = 100% demo control; interface-faithful = drop-in mainnet swap. |
| D2 | Mock fidelity | **Mirror BOTH deposit models** | Scallop and Navi have structurally different deposit semantics (see §3.1). Mocking only one forces a router rewrite at mainnet swap. |
| D3 | `AllocationCap` role | **Employee-owned authorization token; ratios live in shared registry** | Sui semantics: an owned object can only be a PTB input for its owner. Payday is run by the employer, so the employee's ratios MUST live in shared state the employer can read. The cap gates *writes* to those ratios + gates *withdrawals* of vault positions. |
| D4 | Employee object model | **`Table<address, EmployeeRecord>` embedded in the shared `Payroll` object** | Avoids per-employee shared-object contention; one object for the employer to manage; float accounting is local. |
| D5 | Multi-employer | **MVP single-employer; schema forward-compatible** | `AllocationCap` carries `payroll_id`; multi-employer in v1 = one cap per payroll. No schema lock. |
| D6 | Tax escrow granularity | **Single shared `TaxEscrow` with `Table<jurisdiction, Balance<USDC>>`** | One object to manage; per-jurisdiction float (revenue line `§10.2`) is trivially queryable; cross-jurisdiction payday touches one shared object, not N. |
| D7 | Pyth FX | **Real Pyth integration** | Pyth has stable Sui testnet feeds (unlike Scallop/Navi); FX snapshot is the one external integration we keep real for demo authenticity. |
| D8 | Vault-outage fallback | **In-Move conditional routing, not abort** | `BUSINESS_SPEC §13`: a down vault must NOT abort the whole payday. `route()` checks vault `active` flag; inactive → that bucket falls into liquid. Mock exposes a `set_active(false)` to demo this. |
| D9 | Stale FX behavior | **Degrade, do NOT abort** | `fx_rate` only feeds `PayrollEventV1` (local-currency reporting/forensics); it is **not** in the USDC value path (gross/withholding/net/buckets are all USDC u64). Aborting all employees' pay on a reporting-only oracle contradicts D8 and is a self-inflicted DoS. Stale Pyth (>60s) → record `fx_stale=true` + best-available rate in the event; payday proceeds. |
| D10 | Anti-frontrun staging unit | **Payroll *period* counter, not Sui epoch** | Sui epochs (~24h, auto-advancing) are decoupled from payday cadence (bi-weekly/monthly), so epoch-based staging lets an employee change ratios the day before payday and have it take effect — defeating the anti-frontrun intent. Staging keys on `Payroll.current_period`, incremented once per payday run. |
| D11 | Shared-object upgrade governance | **`version: u64` field + `assert_version` on every mutating entry** | `UpgradeCap` is retained (§12). Without a version gate, a post-upgrade old-module version can still mutate `Payroll`/`TaxEscrow`, so deprecated logic can't be fenced off. Standard Sui upgradeable-package discipline for a money-handling contract. |

---

## 1. Executive Summary

PayrollFlow turns a payroll run into a single Programmable Transaction Block. An employer funds a shared
`Payroll` object with USDC; on payday a TS orchestrator builds one PTB with N per-employee branches. Each
branch atomically: (a) reserves employer-side tax withholding into a segregated `TaxEscrow`, (b) splits the
remaining net per the employee's on-chain allocation ratios into a Scallop-style yield receipt, a Navi-style
BTC-index position, and a liquid `Coin<USDC>`, and (c) emits a structured compliance event. Value
conservation is enforced by Move's linear coin type: `gross = withholding + Σ allocation buckets` holds by
construction or the PTB aborts.

For the hackathon, the two yield venues are **interface-faithful mock vaults** deployed on testnet that
mirror the real Scallop (`protocol::mint`) and Navi (`lending_core`) mainnet contract shapes, so the
post-GTM swap to mainnet adapters is drop-in. Pyth FX snapshots are real.

---

## 2. Module Architecture

```
payroll_flow (package)
├── payroll          — Payroll shared object, EmployeeRecord, PayrollOwnerCap, run-payday entry
├── allocation       — AllocationCap (employee), AllocationConfig, set_ratios, route()
├── escrow           — TaxEscrow shared object, reserve(), remit()
├── compliance       — PayrollEventV1 event, sum-check assertions
├── vault_std        — the deposit interface contract + YieldReceipt witness types
└── vaults
    ├── mock_scallop — receipt-coin model: mint<T>() -> Coin<MockSCoin<T>>
    └── mock_navi    — account/address-keyed model: deposit(beneficiary, coin) (no return)
```

Dependency direction (no cycles, verified against actual imports):
`vaults::* → vault_std`; `allocation → vaults::{mock_scallop, mock_navi}`;
`payroll → allocation, escrow, compliance, vaults::{mock_scallop, mock_navi}`.
Note `allocation` does **not** import `escrow` or `vault_std` directly — escrow is touched only by the
`payroll` wrapper, and `vault_std` is referenced only by the mock vaults. See
[`module-dependency.mmd`](../architecture/module-dependency.mmd).

**Why this split:** `vault_std` is the seam that makes D1/D2 work — it pins the *shape* of a vault's
deposit functions so the mock and the future mainnet adapter stay drop-in compatible.

**Seam reality (no traits in Move):** `route()`/`pay_one` have no dynamic dispatch — they call concrete
`mock_scallop::mint` / `mock_navi::deposit` by name, and the **two venue slots are hardwired into the
function signatures**. The mainnet swap of an *existing* venue is **replacing the body of that mock module
while keeping its signature** (the mock module *is* the adapter slot) — call sites and value-conservation
logic do not change. But `vault_std` is **not a general extensible interface**: adding a *third* venue is a
signature change to `route()`/`pay_one` (a breaking edit + D11 upgrade), not a body swap. MVP is two slots,
hard-wired by design.

---

## 3. The Vault Seam (core of the mock strategy)

### 3.1 Why two models — verified against real source

| | **Scallop** `protocol::mint::mint` | **Navi** `lending_core` |
|---|---|---|
| Signature | `public fun mint<T>(version, market: &mut Market, coin: Coin<T>, clock, ctx): Coin<MarketCoin<T>>` | `public entry fun entry_deposit<T>(...)` / `public fun deposit_with_account_cap<T>(...)` |
| Returns | ✅ `Coin<MarketCoin<T>>` (sCoin) — PTB-composable value | ❌ nothing |
| Position recorded in | the receipt coin itself (bearer) | shared `Storage.user_info` / `TokenBalance.user_state: Table<address, u256>` (account-keyed) |

Sources (verified, 2026-05-30):
[scallop `mint.move`](https://github.com/scallop-io/sui-lending-protocol/blob/main/contracts/protocol/sources/user/mint.move) ·
[navi `incentive_v3.move` / `lending.move` / `storage.move`](https://github.com/naviprotocol/navi-smart-contracts/blob/main/lending_core/sources/incentive_v3.move).

**Implication that shaped D3:** Navi credits supply to the tx **sender** (or an `AccountCap`). Payday's sender
is the employer — so a naive Navi deposit would credit the *employer*, violating "employers never custody
employee yield exposure" (`BUSINESS_SPEC §6.2`). The mock therefore mirrors Navi's *underlying* accounting
(address-keyed `Table`) and exposes a `beneficiary: address` parameter, so payday credits the employee
directly. Mainnet-migration note: real Navi requires either a per-employee `AccountCap` stored in the
registry or a co-signed/sponsored deposit; documented in §12.

### 3.2 `vault_std` interface

Move has no traits; the "interface" is a documented function-shape contract each vault module must satisfy,
plus shared marker types.

```move
module payroll_flow::vault_std {
    /// Deposit outcome the router must handle. A vault EITHER returns a bearer receipt coin
    /// (Scallop model) OR records the position internally and returns nothing (Navi model).
    /// The router distinguishes by calling the model-specific adapter fn, not by branching here.

    /// Every vault exposes a liveness flag the router reads for D8 fallback.
    public fun assert_active(active: bool, err: u64) { assert!(active, err) }
}
```

The two concrete shapes the router calls:

```move
// Scallop-shaped (bearer receipt). Router transfers the receipt to the employee.
public fun mint<T>(vault: &mut MockScallopVault, coin: Coin<T>, clock: &Clock, ctx: &mut TxContext)
    : Coin<MockSCoin<T>>

// Navi-shaped (account-keyed, no return). Router passes employee as beneficiary.
public fun deposit<T>(vault: &mut MockNaviVault, beneficiary: address, coin: Coin<T>, clock: &Clock)
```

### 3.3 Mock vault internals (mirror, not stub)

`MockScallopVault` holds `Balance<T>` reserves + an exchange-rate accumulator that ticks with `clock` so
sCoin appreciates (mirrors `MarketCoin` semantics). `redeem<T>(sCoin) -> Coin<T>` returns principal + accrued.

`MockNaviVault` holds `Balance<T>` reserves + `positions: Table<address, u128>` (mirrors
`TokenBalance.user_state`). `withdraw<T>(vault, amount, ctx)` checks `positions[sender]` and pays out.
Both expose `set_active(&AdminCap, bool)` for the D8 outage demo and an `index_price` field on the Navi mock
to act as the BTC-index proxy (`BUSINESS_SPEC §7 MVP`).

---

## 4. Data Structures

```move
// --- payroll module ---
public struct Payroll has key {
    id: UID,
    version: u64,                           // D11: upgrade gate; assert_version() on every mutating entry
    owner_cap_id: ID,                       // the PayrollOwnerCap authorized to mutate
    funding: Balance<USDC>,                 // employer-funded payday pool
    employees: Table<address, EmployeeRecord>,
    current_period: u64,                    // D10: payday counter; +1 per run; allocation staging key
}

public struct EmployeeRecord has store {
    employee: address,
    jurisdiction: vector<u8>,               // e.g. b"AR", b"US-1099"
    gross: u64,                             // per-period gross, USDC (6 decimals)
    withholding_bps: u16,                   // employer-set, ≤ 10000
    allocation: AllocationConfig,           // ratios live HERE (shared) — see D3
    allocation_cap_id: ID,                  // the employee's cap authorized to mutate `allocation`
    active: bool,
}

public struct PayrollOwnerCap has key, store { id: UID, payroll_id: ID }   // employer (held by multisig)

// --- allocation module ---
public struct AllocationCap has key, store {            // EMPLOYEE-owned authorization token
    id: UID,
    payroll_id: ID,                         // D5: ties cap to one payroll; multi-employer = multiple caps
    employee: address,
}

public struct AllocationConfig has store, copy, drop {
    liquid_bps: u16,
    scallop_usdc_bps: u16,
    navi_btc_bps: u16,                      // Σ == 10000
    effective_from_period: u64,             // D10 anti-frontrun: mutations apply next payday period
    pending: Option<PendingRatios>,         // staged change; promoted when current_period >= effective_from_period
}

// --- escrow module ---
public struct TaxEscrow has key {           // single shared object (D6)
    id: UID,
    version: u64,                           // D11: upgrade gate
    by_jurisdiction: Table<vector<u8>, Balance<USDC>>,
}
```

`USDC` here is the testnet coin type used for the mock; swapped for the canonical mainnet USDC type at GTM.

---

## 5. Core Functions

```move
// payroll
public fun create_payroll(ctx): (Payroll, PayrollOwnerCap)            // share Payroll, send cap to employer
public fun fund(payroll: &mut Payroll, cap: &PayrollOwnerCap, c: Coin<USDC>)
public fun add_employee(payroll: &mut Payroll, cap: &PayrollOwnerCap, employee, jurisdiction, gross,
                        withholding_bps, ctx): AllocationCap          // mints cap, sends to employee
public fun set_gross(payroll: &mut Payroll, cap: &PayrollOwnerCap, employee, gross)

/// D10: bump current_period exactly once per payday, before the first pay_one of the run.
public fun begin_period(payroll: &mut Payroll, cap: &PayrollOwnerCap)

/// One per-employee branch of the payday PTB. Pure value-conserving split.
/// Aborts (whole PTB) only on funding shortfall or bad config — NOT on vault outage (D8).
public fun pay_one(
    payroll: &mut Payroll, cap: &PayrollOwnerCap,
    escrow: &mut TaxEscrow,
    scallop: &mut MockScallopVault, navi: &mut MockNaviVault,
    employee: address,
    price: &PythPrice, clock: &Clock, ctx: &mut TxContext,
)

// allocation
public fun set_ratios(payroll: &mut Payroll, cap: &AllocationCap, liquid, scallop, navi)  // staged → effective next period (D10)
public fun pause(payroll: &mut Payroll, cap: &AllocationCap)          // 100% liquid one cycle
/// internal: splits net into buckets, deposits per model, returns liquid coin for the employee.
fun route(net: Coin<USDC>, cfg: &AllocationConfig, scallop, navi, employee, clock, ctx): Coin<USDC>

// escrow
public fun reserve(escrow: &mut TaxEscrow, jurisdiction, amt: Balance<USDC>)
public fun remit(escrow: &mut TaxEscrow, cap: &PayrollOwnerCap, jurisdiction, amount, to, ctx)
```

### Payday value flow (per employee, inside `pay_one`)

```
assert_version(payroll)                                    // D11
cfg = committed_config(record, payroll.current_period)     // D10: promote pending if current_period >= effective_from_period, else use live ratios
gross_coin = balance::split(payroll.funding, gross)        // aborts if funding < gross (E_INSUFFICIENT_FUNDING)
withholding = ((gross as u128) * (withholding_bps as u128) / 10000) as u64   // u128 intermediate, no overflow
escrow.reserve(jurisdiction, gross_coin.split(withholding)) // employer-side
net = gross_coin                                            // remainder
liquid = allocation::route(net, cfg, scallop, navi, employee, clock, ctx)
transfer::public_transfer(liquid, employee)
(fx_rate, fx_stale) = read_fx(price, clock)                // D9: stale (>60s) → fx_stale=true, best-available rate; NO abort
compliance::emit(employer, employee, jurisdiction, gross, withholding, net, buckets, fx_rate, fx_stale, period)
// Invariant by linear types: gross == withholding + scallop_amt + navi_amt + liquid_amt
// (fx is reporting-only; never touches this equation — see D9)
```

`current_period` is bumped **exactly once per payday** by a `begin_period(payroll, cap)` entry the
orchestrator calls before the first `pay_one` (a >50-employee payday spans multiple PTBs but is still one
period — `begin_period` runs once, in the first PTB). `pay_one` does **lazy per-record promotion**: when it
reads a record whose `pending` is set and `current_period >= pending.effective_from_period`, it promotes that
one record in place (no Table-wide iteration). This keeps all N employees on the same period snapshot while
bounding gas to O(1) per employee. `route()` per bucket: if `scallop.active` → `mint` sCoin, transfer to
employee; else add to liquid (D8). Same for navi via address-keyed `deposit(employee, ...)`. The liquid
bucket is the natural remainder, so the sum-check is structural, not asserted arithmetic.

---

## 6. Permission System (Capabilities)

| Capability | Holder | Authorizes |
|------------|--------|------------|
| `PayrollOwnerCap` | Employer **2-of-N multisig** address (`BUSINESS_SPEC §13`) | fund, add/edit employee, run payday, remit escrow |
| `AllocationCap` | Employee address | mutate own `allocation` ratios (staged, next period) |
| `AdminCap` (per mock vault) | Deploy/demo operator | `set_active` for outage demo only — not in mainnet adapter |

Capability checks are by `id`/`address` equality against the record, not by `&signer` alone. Multisig is
enforced at the Sui account layer (the address owning `PayrollOwnerCap` is a multisig), not in Move.

**Withdrawal is NOT cap-gated** (corrects an earlier draft): the two vault models gate withdrawal by
ownership, not by `AllocationCap`. Scallop-model exposure is a **bearer sCoin** transferred to the employee —
holding the coin *is* the claim. Navi-model exposure is **address-keyed**: `mock_navi::withdraw` pays out
against `positions[ctx.sender]`, so only the employee whose address holds the position can withdraw.
`AllocationCap` authorizes ratio mutation only.

---

## 7. Event System

```move
public struct PayrollEventV1 has copy, drop {
    payroll_id: ID, employer: address, employee: address,
    jurisdiction: vector<u8>, period: u64,
    gross: u64, withholding: u64, net: u64,
    liquid_amt: u64, scallop_amt: u64, navi_amt: u64,
    fx_pair: vector<u8>, fx_rate: u64, fx_pyth_publish_time: u64,   // §3 auditor sum-check + forensics
    fx_stale: bool,                                                // D9: true if Pyth >60s; payday still proceeds
}
```

> **⚠ FX unit contract (pin before #7 Pyth integration):** `fx_pyth_publish_time` is in **milliseconds**.
> `payroll::is_fx_stale` compares it against `clock.timestamp_ms()` with `FX_STALE_MS = 60_000`. Native Pyth
> `PriceInfoObject.publish_time` is in **seconds** — the #8 TS orchestrator (and the #7 on-chain Pyth read)
> **must multiply by 1000** before passing it in. Feeding raw Pyth seconds would make every event read as
> `fx_stale=true` (≈50 years stale), corrupting the auditor staleness signal. D9 keeps this off the USDC
> value path, so it never mis-pays — but the forensic flag would be wrong. Unit is ms, end to end.

Versioned (`V1`) so the indexer schema and auditor receipts survive contract upgrades. The auditor sum-check
(`BUSINESS_SPEC UC3`) is: `gross == withholding + liquid_amt + scallop_amt + navi_amt` verified against the
event — must match the on-chain object mutations exactly.

---

## 8. Error Handling

```
E_NOT_OWNER            = 1   // PayrollOwnerCap mismatch
E_NOT_ALLOCATION_OWNER = 2   // AllocationCap mismatch
E_INSUFFICIENT_FUNDING = 3   // payday pool < gross
E_RATIOS_SUM           = 4   // allocation bps != 10000
E_WITHHOLDING_RANGE    = 5   // withholding_bps > 10000
E_UNKNOWN_EMPLOYEE     = 7
E_VAULT_PRINCIPAL      = 8   // withdraw exceeds recorded position
E_WRONG_VERSION        = 9   // D11: shared object version != package VERSION
```

> `E_STALE_FX` (was #6) is **removed**: per D9, stale FX no longer aborts. The 60s check now sets the
> `fx_stale` event flag instead of raising; payday proceeds. Code `6` is retired (not reused) to keep
> `PayrollEventV1` forensics and any prior references unambiguous.

FX staleness is **non-fatal** (D9): the <60s freshness check feeds the `fx_stale` event flag; it never
aborts the payday. FX is reporting-only and is not in the USDC value path.

---

## 9. Security Considerations (summary; full model in threat-model.md)

Red-team vectors (per `.claude/rules`), ≤5, with the defense baked into the design:

1. **Allocation front-running payday** — employee races slider before payday to dodge withholding/route to
   liquid. *Defense:* `effective_from_period` staging (D10) — ratio changes apply next **payday period**, not
   next Sui epoch; payday reads the committed snapshot. Epoch-based staging was rejected because Sui epochs
   (~24h, auto-advancing) decouple from payday cadence and would let a day-before change take effect.
2. **Unauthorized payday / fund drain** — *Defense:* every mutating fn checks `PayrollOwnerCap.payroll_id`;
   the cap lives on a 2-of-N multisig.
3. **Withholding underflow / value leak** — *Defense:* linear-type split conserves value; sum-check is
   structural; `withholding_bps ≤ 10000` enforced.
4. **Stale FX → wrong tax conversion / oracle-induced DoS** — *Defense:* D9. FX is reporting-only (not in the
   USDC value path), so a stale feed cannot corrupt on-chain value movement. The <60s check sets `fx_stale`
   in the event (auditor sees the degraded snapshot) instead of aborting — aborting all employees' pay on a
   reporting-only oracle would itself be the DoS (consistent with vector #5 / D8). Pyth publish_time recorded
   for forensics.
5. **Vault outage aborts whole payroll (DoS)** — *Defense:* D8 conditional routing; an inactive vault routes
   that bucket to liquid instead of aborting N employees' pay.

---

## 10. Tool Integration Plan

| Concern | Tool | Status |
|---------|------|--------|
| Yield (USDC supply) | Scallop `protocol::mint` | **mocked** (`mock_scallop`), mainnet adapter post-GTM |
| BTC-index | Navi `lending_core` | **mocked** (`mock_navi`), mainnet adapter post-GTM |
| FX snapshot | **Pyth** | **real** testnet feed |
| Employee onboarding | zkLogin + Sponsored TX (Enoki) | v1 (`BUSINESS_SPEC §7`) |
| Indexer | custom Postgres on `PayrollEventV1` | MVP for auditor/dashboard |
| Frontend | Next.js employer dashboard + employee PWA | MVP |
| Data access | gRPC (state) + GraphQL (frontend) | Protocol 124; JSON-RPC deprecated |

---

## 11. Testing Strategy

- **Unit (Move):** value-conservation invariant (property-style: random gross/withholding/ratios →
  `gross == Σ buckets`); ratio-sum guard; withholding range; **withholding u128 no-overflow at gross near
  u64::MAX**; cap-mismatch aborts; **D11 `assert_version` aborts on stale version**.
- **Scenario:** full `pay_one` with active/inactive vaults (D8 fallback lands in liquid); **D9 stale FX →
  `fx_stale=true`, payday still pays (NO abort), value invariant unchanged**; **D10 period-staged ratio
  change does NOT affect current period's payday and DOES apply after `begin_period` bumps the period — even
  if multiple Sui epochs elapsed between set_ratios and payday** (the epoch-decoupling regression test).
- **Monkey/extreme** (`.claude/rules/test.md`): gross=0, withholding=10000 (100%), ratios all-in-one-bucket,
  funding exactly == Σ gross (no slack), 50-employee PTB (object-limit boundary per `BUSINESS_SPEC §13`),
  paused employee mid-batch, **`begin_period` called twice in one payday (period must not double-advance the
  staging semantics), set_ratios spammed every block before payday (all must stage to the same next period)**.
- **Gas tracking** via `sui-tester` at 3 / 50 / 100 employees to validate batch-size strategy.
- Review pipeline (project rule): `move-code-quality` → `sui-security-guard` → `sui-red-team` for core
  modules (`payroll`, `allocation`, `escrow`). Generic reviewer is **not** used on `.move`.

---

## 12. Deployment & Mainnet Migration

- **MVP:** `sui move build` + `sui move test` clean → publish to **testnet**. Mock vaults + Pyth real.
- **PTB orchestration:** TS backend batches ≤50 employees/PTB; >50 → N PTBs (object limit, `§13`).
- **Operator invariant (canonical vault IDs):** `pay_one` accepts *any* same-type `MockScallopVault` /
  `MockNaviVault` and has **no on-chain guard** binding the Payroll to a specific vault (vault is an
  un-bound singleton by design — see §2 / `move-notes.md`). The #8 orchestrator therefore **must** pass the
  canonical mainnet scallop/navi vault object IDs on every payday PTB. A wrong-but-same-type vault would
  route funds to the wrong pool with no abort. This is an off-chain operator responsibility, not a contract
  fix; pin the canonical IDs in orchestrator config.
- **Mainnet swap (replace mock module body, keep `vault_std` signature — see §2 seam reality):**
  - `mock_scallop` body → real Scallop call `protocol::mint::mint` (non-entry, returns sCoin). Pass real
    `Version`/`Market` objects; resolve addresses dynamically via Scallop SDK (do **not** hardcode —
    upgradeable package IDs change). `route()` is untouched; only this module's body changes.
  - `mock_navi` body → real Navi call. **Open migration task:** real Navi credits sender/`AccountCap`, not
    arbitrary beneficiary. Options: (a) mint a per-employee Navi `AccountCap` at onboarding, store its handle
    in the registry; (b) sponsored/co-signed deposit. Decide before GTM (tracked in `move-notes.md`).
  - Swap mock `USDC` type → canonical mainnet USDC type.
- `UpgradeCap` retained by the employer/protocol multisig; `PayrollEventV1` versioning protects the indexer.
- **Upgrade discipline (D11):** every package upgrade bumps the module `VERSION` const and ships a one-shot
  `migrate(&mut Payroll, &PayrollOwnerCap)` / `migrate(&mut TaxEscrow, ...)` that sets the shared object's
  `version` to the new `VERSION`. Mutating entries `assert_version` first, so the old module version is fenced
  off the instant the object is migrated.
- **Migrate invariant (Payroll ⇔ escrow migrate together):** a `Payroll` is bound to its `TaxEscrow` via
  `escrow_id` (enforced at `pay_one` by `EWrongEscrow`). After an upgrade, **both shared objects must be
  migrated in the same release** before the next payday — `pay_one` requires `assert_version` to pass on
  *both*. Migrating one and not the other bricks payday (version fence) until the pair is consistent. Treat
  the `(Payroll, its TaxEscrow)` pair as a single migration unit; never migrate them in separate upgrades.

---

## 13. Gas Optimization

- One shared `Payroll` + one shared `TaxEscrow` per payday PTB → minimize shared-object contention (D4/D6).
- `Table` lookups are O(1) dynamic fields; avoid loading the whole employee set into the PTB — orchestrator
  passes the explicit per-employee key list.
- Batch ceiling 50 (object/gas budget); measured at 3/50/100 (§11).
- sCoin/position writes are the dominant cost; liquid-only path (paused employee) is the cheap baseline.

---

## Appendix — Versions & References

- Sui Protocol 124 (testnet v1.72.2 / mainnet v1.71.1), SDK `@mysten/sui`, `Transaction` API.
- Scallop interface verified: `scallop-io/sui-lending-protocol` `protocol::mint`.
- Navi interface verified: `naviprotocol/navi-smart-contracts` `lending_core`.
- Business source: `BUSINESS_SPEC.md` (PayrollFlow, ~2,400 words).
- Diagrams: `docs/architecture/module-dependency.mmd`, `docs/architecture/data-flow.mmd`.
- Threat model: `docs/security/threat-model.md`.
