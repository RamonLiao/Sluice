# Employer Dashboard — Sui Integration Architecture Review

_Date: 2026-06-21_
_Reviewer: sui-architect_
_Target spec: docs/superpowers/specs/2026-06-21-employer-dashboard-design.md_
_Grounded in: move/sources/payroll.move, move/sources/allocation.move, ts/src/payday/{grpc-client,execute-types}.ts_

Scope: Sui-specific correctness of the **frontend integration design** only. No files modified. The
backend design is out of scope and accepted as deployed/verified.

---

## Critical

### C1 — Sequential wallet popups will equivocate the shared `Payroll` (and the gas coin) across chunks

The spec (Run Payroll, step 4; Error handling) signs each chunk **sequentially via separate wallet
popups**, chunk[0] carrying `begin_period`. Every chunk takes `&mut Payroll` (shared) + the owner cap
(owned) + `&mut TaxEscrow` + `&mut` vaults + a gas coin. The risk is **not** the shared object — the
validator assigns shared-object versions at execution and chunk N simply waits for chunk N-1's effects.
The real risks are the **owned inputs**:

- **Owner cap + gas coin version drift.** `tx.build()` (see `grpc-client.ts:build`) pins the *current*
  version of every owned input at build time. If the dashboard builds all N chunk transactions up front
  (natural with `buildPayday` returning a full `PaydayPlan`) and then signs them one popup at a time,
  chunks 2..N reference the **stale pre-mutation version** of the gas coin (mutated by chunk 1's gas
  payment) and the owner cap (its version bumps as a tx input). Result: chunk 2 fails
  `ObjectVersionUnavailableForConsumption` / equivocation, or — worse on a wallet that auto-selects gas
  — the same gas coin is locked across two in-flight txs → **equivocation, owner locked out until
  epoch change.** This is exactly Phase A note **H2b** ("re-fetch owner cap + gas coin version per
  chunk").

**Fix (must be in the spec, not discovered in build):**
1. **Build + sign + execute + `waitForConfirm` strictly per chunk, in a loop** — never pre-build all
   chunks. Re-resolve owned inputs each iteration (a fresh `tx.build({ client })` after the prior chunk
   confirmed re-reads current versions). The existing `GrpcPaydayClient` already does build→sign→execute
   →wait *per call*; the `DappKitPaydayClient` MUST preserve that ordering and MUST NOT batch-build.
2. **Do not pin the gas coin.** Let the wallet pick gas per popup, and ensure chunk N is only built
   after chunk N-1 is confirmed (so the wallet sees the post-mutation coin set). If you must pin gas,
   pin a **different** coin than any tx input and re-fetch its version each chunk.
3. The owner cap (`PayrollOwnerCap`, owned) is an input to every chunk — its version advances each tx.
   The per-chunk rebuild in (1) covers it; calling it out explicitly prevents a "build once, sign many"
   regression.

Without this the dashboard's headline "one-click Run Payroll" bricks the employer's cap on the second
chunk. Single-chunk paydays (≤50 employees) hide the bug in demos — it only bites at chunk[1], so it
**must** be designed for, not tested into.

### C2 — Re-running chunk[0] on resume re-bumps the period (double `begin_period`) — frontend must hard-gate

The spec says resume "never re-runs from scratch" and relies on `expectedPeriod`. That's correct, but the
frontend wiring must guarantee it. `begin_period` (`payroll.move:176`) unconditionally does
`current_period += 1` with no idempotency. The on-chain `pay_one` idempotency (`last_paid_period < period`)
protects against double-*pay* within a period, but a second `begin_period` opens a **new** period in which
every employee is payable again. The money-safety boundary is therefore "never submit a second
`begin_period`", enforced by `executePayday`'s `expectedPeriod` gate (`PeriodGateError`).

**Fix:** the dashboard MUST pass `expectedPeriod = getCurrentPeriod()` *immediately before* every Run /
Resume, and MUST pass `resumeFrom` (from `nextResumeFrom`) on resume so chunk[0] is **skipped**, not
rebuilt. Spec already names both knobs but does not make passing them mandatory/wired — promote to a
hard requirement with the read-period-then-gate ordering. Also: on resume, re-read period *after* the
user reconnects the wallet (a reconnect can race a concurrent operator). See C1 — resume rebuilds chunks,
so it inherits the per-chunk-rebuild requirement for free if C1 is implemented correctly.

---

## Important

### I1 — `EmployeeRecord` is a Table **value**, not its own object — `getDynamicFieldObject` returns a wrapper layer

The read path (`getDynamicFields(tableId)` → `getDynamicFieldObject` per entry) is the right *shape*, but
the spec underestimates the decode. `Table<address, EmployeeRecord>` stores each entry as a dynamic
**field** (`sui::dynamic_field`, the `Field<K,V>` wrapper), not a dynamic object field. So:

- `getDynamicFieldObject({ parentId: tableId, name })` returns an object whose `content.fields` is
  `{ name: <address>, value: { <EmployeeRecord fields> } }` — the record is **nested under `.value`**,
  one wrapper layer deeper than a naive read assumes. Parsing `gross`/`withholding_bps` from the top
  level silently yields `undefined` → mispay. (Spec's own test note "a misparsed gross pays the wrong
  amount" is exactly this trap.)
- `EmployeeRecord.allocation` is a **nested struct** `AllocationConfig { liquid_bps, scallop_usdc_bps,
  navi_btc_bps, pending: Option<PendingRatios> }`. `pending` is a Move `Option` → JSON-RPC renders it as
  `{ fields: { vec: [] } }` (empty = none) or `{ vec: [ {…} ] }`. The reader must handle the Option
  vec-wrapper, not assume `pending` is null/object.
- `jurisdiction: vector<u8>` renders as a **byte array**, not a string — decode to UTF-8/hex explicitly
  (it's the FX-pair / tax-region key; wrong decode → wrong FX lookup).
- `withholding_bps` is `u16` and the bps fields are `u16` → fine as JS number, but `gross`, `current_period`,
  `last_paid_period` are `u64` → JSON-RPC returns **strings**; parse with `BigInt`, never `Number`
  (>2^53 mispay / precision loss). The orchestrator's `decodeCurrentPeriod` already treats period as
  `bigint` — the reader must match.

**Fix:** spec must mandate BCS-or-typed decode through the `Field` wrapper (`.value.fields`), Option
unwrap for `pending`, byte-array decode for `jurisdiction`, and `BigInt` for all `u64`. Best practice on
P126: prefer **GraphQL** (`object { dynamicFields }`) or a typed BCS struct decode over hand-walking
JSON-RPC `content.fields` — JSON-RPC is deprecated (Quorum Driver off; full deactivation 2026-07-31) and
its nested-field JSON is the most fragile surface here. At minimum, pin the decode behind the
`PayrollReader` port (spec already isolates it) and unit-test against a **real** captured dynamic-field
response, not a hand-written mock (a hand mock will encode the same wrong assumption the parser has).

### I2 — `getDynamicFields` pagination not addressed (page cap 50)

`getDynamicFields` is **paginated**, default/typical page ≤ 50 and `hasNextPage`/`nextCursor` must be
followed. The roster for a real payroll can exceed 50 (MAX_BATCH=50 is the *chunk* size, unrelated to
read pages). Spec's `ChainPayrollReader` shows a single `getDynamicFields(tableId)` with no cursor loop →
silently truncates the roster to the first page → those employees are **invisible in the UI and omitted
from the payday plan** (under-pay / skipped staff, fail-silent — violates Rule 12).

**Fix:** mandate cursor pagination (`while hasNextPage`) in `ChainPayrollReader`, and fetch each entry's
value (N+1 `getDynamicFieldObject` calls, or one `multiGetObjects` batch by field id — prefer the batch).
Add a monkey test: roster of 51+ employees must round-trip fully.

### I3 — `create_payroll` from the browser: discovering the new shared `Payroll` + cap from effects

`create_payroll` (`payroll.move:109`) shares the `Payroll` + `TaxEscrow` and self-transfers the cap, but
**emits no creation event** and returns nothing. From `dapp-kit`'s `signAndExecute` result the dashboard
must dig the three new ids out of `effects.created` (or `objectChanges`) and disambiguate them:

- The wallet's `signAndExecute` by default may **not** return `objectChanges`/full effects — must request
  `{ showObjectChanges: true, showEffects: true }` (dapp-kit: pass `options` to the execute mutation, or
  re-fetch via `client.waitForTransaction({ options })`). Spec doesn't state this → the IDs come back
  empty and the picker can't find the payroll.
- Three objects are created (Payroll shared, TaxEscrow shared, OwnerCap owned-to-sender). Disambiguate by
  **`objectType`** (`...::payroll::Payroll<T>`, `...::escrow::TaxEscrow<T>`,
  `...::payroll::PayrollOwnerCap`) — never by array order (non-deterministic). Then **verify the binding**
  off-chain by reading `Payroll.owner_cap_id` and matching the created cap id (the contract sets it post-
  creation at `payroll.move:122`).

**Fix:** spec should specify the effects options, the type-based disambiguation, and the
`owner_cap_id ↔ cap` cross-check, then persist the discovered ids into `web/src/config/testnet.ts`
shape. Best-practice note: a tiny `event::emit(PayrollCreated{payroll_id, escrow_id, cap_id})` in the
contract would make this robust (and feed the #2 auditor view) — flag as a backend nice-to-have, **not**
required for this frontend.

### I4 — Owner-cap detection: query owned objects by type + filter on `payroll_id`, not just presence

Spec: "show whether the connected address holds the matching `PayrollOwnerCap`." Correct check has **two**
conditions, mirroring on-chain `assert_owner` (`payroll.move:302`):

1. Connected address owns an object of type `...::payroll::PayrollOwnerCap` whose field
   `payroll_id == selectedPayrollId`, **and**
2. that cap's **object id == `Payroll.owner_cap_id`** (read from the shared Payroll).

Both directions matter: the on-chain auth asserts id-match *and* payroll_id-match, so the UI gate must
too, else the UI greenlights a write that the chain will abort (bad UX, wasted gas / popup). Use
`getOwnedObjects({ owner, filter: { StructType: "<pkg>::payroll::PayrollOwnerCap" }, options:{showContent}})`
with cursor pagination, then filter by `payroll_id`, then cross-check `owner_cap_id`.

**Fix:** spec's "matching cap" must be defined as this two-way check, not mere "holds a cap."

---

## Nice-to-have

### N1 — `begin_period` in chunk[0]: wallet-reject ordering is already safe; document the UI invariant
If the user rejects chunk[0], `begin_period` never lands, period stays put, `nextResumeFrom` stays 0 →
clean retry. If they reject chunk[N>0], period already advanced and chunks 0..N-1 are paid → resume from N.
The design is correct; just make the UI state machine encode "rejected chunk[0] ⇒ full retry allowed;
rejected chunk[N>0] ⇒ resume-only, full re-run disabled" so an operator can't manually re-trigger a fresh
run (which would re-`begin_period`). This is a UI-guard restatement of C2, not a new defect.

### N2 — Coin selection for `fund`
`fund` takes `Coin<T>` (testnet `0x2::sui::SUI`). The fund panel must split/merge a coin of the right
type and avoid using the gas coin as the fund coin in the same PTB (gas-coin reuse). On P126 mainnet with
native address balances this simplifies, but on testnet SUI it's manual `splitCoins(gas, [amount])` or a
selected non-gas coin. Minor, but worth a line so it isn't improvised.

### N3 — Prefer GraphQL/gRPC over deprecated JSON-RPC for the read path
The whole read path rides JSON-RPC `content.fields` (most fragile + deprecated, off 2026-07-31). The
orchestrator's transitional JSON-RPC is justified (gRPC resolve broken in 1.45.2) — but the **reader** has
no such blocker and could use GraphQL (`object{ dynamicFields }`, beta, frontend-oriented) for a sturdier
typed read. Keep behind `PayrollReader` so it's swappable. Not blocking for the hackathon demo.

---

## Summary

| # | Severity | One-line |
|---|----------|----------|
| C1 | Critical | Per-chunk **rebuild** owned inputs (cap + gas coin); never batch-build N chunks → else equivocation/version-drift bricks the cap at chunk[1]. |
| C2 | Critical | Mandatorily wire `expectedPeriod` (read-then-gate) + `resumeFrom` so resume never re-`begin_period` (double-pay). |
| I1 | Important | Decode `EmployeeRecord` through the `Field.value` wrapper; Option-unwrap `pending`; byte-decode `jurisdiction`; `BigInt` all `u64`. |
| I2 | Important | Paginate `getDynamicFields` (cursor loop) — single page silently truncates roster >50. |
| I3 | Important | `create_payroll`: request `showObjectChanges`, disambiguate by `objectType`, cross-check `owner_cap_id`. |
| I4 | Important | Owner-cap gate = type filter + `payroll_id` match + `owner_cap_id` id-match (mirror `assert_owner`). |
| N1 | Nice | Encode the chunk[0]-reject-vs-N-reject UI invariant. |
| N2 | Nice | `fund` coin selection: avoid gas-coin reuse. |
| N3 | Nice | Prefer GraphQL/gRPC over deprecated JSON-RPC for reads (behind the port). |

The orchestrator core (`PaydayClient` port, `expectedPeriod`/`resumeFrom` machinery, per-call
build→sign→execute→wait) is the right seam and already encodes the safety primitives — C1/C2 are about
**not regressing them** in the `DappKitPaydayClient` adapter and UI wiring, not about new contract work.
