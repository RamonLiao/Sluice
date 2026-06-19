# PayrollFlow #8 — Payday PTB Builder (TS orchestrator, Phase A)

_Design — 2026-06-19_

## Scope

Phase A of the #8 TS orchestrator: a **pure, IO-free PTB builder** inside
`@payroll-flow/orchestrator`. It turns a payday's employee list into one or more
`@mysten/sui` `Transaction` objects, each carrying ≤50 `pay_one` move calls plus a
single `begin_period` on the first chunk. It does **not** sign, submit, or read chain
state.

Deferred to later phases (new chat each):
- **Phase B** — executor: keypair signing, `SuiClient` submit, effects parsing.
- **Phase C** — `dryRun`/`devInspect` gas measurement at 3/50/100 employees (spec §11).
- **Future upgrade B (from Q2)** — builder reads `Payroll.employees` Table on-chain to
  derive the employee set instead of taking it as a parameter. Couples chain IO into the
  builder; out of scope for Phase A.

## Data flow

```
Caller prepares (all IO happens here, outside the builder):
  employees : { addr: string, pair: FxPair }[]   // who to pay + each one's currency
  fxByPair  : Map<FxPair, FxScalars>              // caller batch-calls getFxScalars once per pair
  config    : PaydayConfig                        // pinned shared-object IDs + types
        |
        v
buildPayday(employees, fxByPair, config) -> PaydayPlan
        |
        v
PaydayPlan {
  transactions : Transaction[]      // N chunks, each a fully-built PTB
  chunks       : PaydayChunk[]      // metadata: { employees: string[], hasBeginPeriod: boolean }
}
```

Rationale: the builder stays pure (no Pyth fetch, no chain read). FX is fetched **once per
pair per payday** by the caller and injected, guaranteeing rate consistency across the whole
payday and minimizing Pyth calls. Employee list is a parameter (Q2 decision A).

## Types

```ts
type FxPair = "EUR/USD" | "GBP/USD" | "JPY/USD" | "EUR/GBP"; // reuse fx/types.ts

interface PaydayEmployee { addr: string; pair: FxPair; }

interface PaydayConfig {
  packageId:  string;
  coinType:   string;   // T type arg for pay_one<T> (e.g. USDC type tag)
  payrollId:  string;
  ownerCapId: string;   // &PayrollOwnerCap input
  escrowId:   string;
  scallopId:  string;   // canonical mainnet vault ID — pinned (spec §2, vault unbound by design)
  naviId:     string;
  clockId:    string;   // 0x6
}

interface PaydayChunk { employees: string[]; hasBeginPeriod: boolean; }
interface PaydayPlan  { transactions: Transaction[]; chunks: PaydayChunk[]; }
```

## Files

```
ts/src/payday/
  types.ts    // PaydayEmployee, PaydayConfig, PaydayChunk, PaydayPlan
  chunk.ts    // pure chunk<T>(arr, size)
  build.ts    // buildPayday() + invariant checks
ts/test/payday/
  chunk.test.ts
  build.test.ts
```

## Batching & begin_period

- `MAX_BATCH = 50` (spec §13 / BUSINESS_SPEC §13 object limit). `chunk()` preserves caller order.
  **(M2)** 50 is a conservative *object-mutation budget* estimate, not a command-count limit (a PTB
  holds up to 1024 commands). Each `pay_one` mutates/creates several objects (liquid coin transfer +
  escrow reserve + 2 vault deposits). The real ceiling is calibrated in **Phase C** gas measurement
  (3/50/100 employees) — annotate the constant as provisional.
- `begin_period` move call is prepended to **chunk[0]'s** Transaction only. The builder owns
  this invariant; the caller cannot get it wrong.
- **Contract:** one `buildPayday` call == one fresh payday. The builder is pure and cannot know
  whether `begin_period` already ran; re-running advances the period again. This risk is
  documented in JSDoc and surfaced via `chunks[0].hasBeginPeriod`. On-chain idempotency
  (`pay_one`'s `last_paid_period < period` guard, #5) is the real protection.
- Empty employee list -> empty plan (no transactions, no spurious `begin_period`).

## Per-branch assembly (`pay_one`)

Argument order mirrors the Move signature exactly (payroll.move:211-223):

```ts
tx.moveCall({
  target: `${cfg.packageId}::payroll::pay_one`,
  typeArguments: [cfg.coinType],
  arguments: [
    tx.object(cfg.payrollId),
    tx.object(cfg.ownerCapId),
    tx.object(cfg.escrowId),
    tx.object(cfg.scallopId),
    tx.object(cfg.naviId),
    tx.pure.address(emp.addr),
    tx.pure.vector("u8", [...fx.fx_pair]),               // vector<u8> fx_pair (M1: idiomatic, no manual bcs)
    tx.pure.u64(fx.fx_rate),                             // bigint — never downcast to number
    tx.pure.u64(fx.fx_pyth_publish_time_ms),             // bigint
    tx.object(cfg.clockId),
  ],
});
```

Shared-object inputs (payroll/escrow/scallop/navi/clock) are referenced once and reused across
all branches in the same Transaction (spec §11: minimize shared-object contention).

## SUI on-chain semantics (sui-architect review findings)

These are real PTB/object-model constraints that shape the Phase A↔B boundary. They MUST hold or
Phase B breaks.

- **[H1] Lazy shared-object resolution.** `payroll/escrow/scallop/navi` are **shared objects** and
  `ownerCapId` is an **owned object**. A pure builder has no `SuiClient`, so it cannot fill
  `initialSharedVersion`/mutable flags (shared) or `version`/`digest` (owned). The `Transaction`
  objects are therefore returned **unresolved** — resolution is deferred to the Phase B executor,
  which holds the client and resolves at sign time. **Consequence for Phase A:** tests use
  `tx.getData()` only; **never call `tx.build()`** in Phase A (it requires resolution and will throw).

- **[H2] Cross-chunk ordering is a hard contract.** `chunk[0]` carries `begin_period` (period 0→1).
  Every `pay_one` checks `last_paid_period < current_period`. If `chunk[1..]` are submitted before
  `chunk[0]` lands, `current_period` is still 0 → `0 < 0` is false → the whole chunk aborts
  (`EAlreadyPaidThisPeriod`). **`PaydayPlan.transactions` order == mandatory submission order, and
  `transactions[0]` must be confirmed on-chain before submitting the rest.** Phase A cannot enforce
  this (it does not submit); it is a hard requirement on the Phase B executor, surfaced via the array
  order + `chunks[0].hasBeginPeriod`.

- **[H3] Owner cap signer binding.** `ownerCapId` (`&PayrollOwnerCap`) is owned by the employer.
  Reusing it across chunks is fine (it is borrowed, not consumed), but Phase B must ensure the PTB
  **signer == cap owner**, else the transaction is unsignable / will fail. Phase B invariant.

## Builder-enforced invariants

1. **fx_pair label ↔ scalars consistency** — `decode(fxByPair.get(emp.pair).fx_pair) === emp.pair`,
   else throw. Enforces the operator invariant (move-notes open-task #4 / architect finding [B]).
2. **u64 precision** — `fx_rate` and `fx_pyth_publish_time_ms` stay `bigint` end-to-end through
   `tx.pure.u64()` (architect finding [A]). Downcasting to JS number loses precision around the
   ~1.7e12 publish_time magnitude.
3. **Missing scalars** — employee `pair` not in `fxByPair` -> throw. Never silently skip a payee.
4. **Duplicate addresses** — builder rejects a duplicated payee address up front (the second
   `pay_one` for the same employee in one period would abort the whole PTB on-chain via the
   `last_paid_period` guard; fail early, fail loud).

## Testing (Rule 9: tests encode intent)

Verify PTB structure via `tx.getData()` (transaction kind / commands). **Never call `tx.build()`
in Phase A** — shared/owned object refs are unresolved (finding [H1]) and `build()` would throw.

- **Chunking:** 0 / 1 / 50 / 51 / 100 employees -> chunk counts ([], [1], [50], [50,1], [50,50]).
- **begin_period once:** chunk[0] first command is `begin_period`; chunk[1..] have none; empty
  list -> no `begin_period`.
- **fx precision:** a u64::MAX-magnitude `fx_rate` bigint round-trips through `tx.pure.u64`
  without loss — encodes *why* the bigint discipline exists (finding [A]).
- **Invariant throws (monkey/red-team):** missing pair in fxByPair; fx_pair bytes mismatching
  emp.pair; duplicate payee address.
- **Arg positional mapping:** all 10 arguments match the `pay_one` signature order/type, guarding
  against silent off-by-one arg bugs.

Out of scope (YAGNI): real signing, submission, gas measurement (Phase B/C).

## Dependencies

Add `@mysten/sui` to `ts/package.json` (currently only `@pythnetwork/hermes-client`). Use its
`Transaction` export (and `tx.pure.vector`/`tx.pure.u64` builder helpers — no manual `bcs` needed
after M1).
