# Payday PTB Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure, IO-free TypeScript PTB builder that turns a payday's employee list into one or more `@mysten/sui` `Transaction` objects (≤50 `pay_one` calls each, `begin_period` on the first chunk).

**Architecture:** A pure function `buildPayday(employees, fxByPair, config)` chunks employees by `MAX_BATCH`, assembles a `Transaction` per chunk mirroring the `payroll::pay_one` Move signature, prepends `begin_period` to chunk[0], and enforces FX/dup invariants up front. No signing, no submission, no chain reads — shared/owned object refs stay unresolved (resolved later by a Phase B executor).

**Tech Stack:** TypeScript (ESM, strict), `@mysten/sui` `Transaction`, vitest. Reuses `@payroll-flow/orchestrator`'s `FxPair`/`FxScalars` from `src/fx/types.ts`.

## Global Constraints

- ESM with explicit `.js` import extensions (matches `src/fx/*`). `moduleResolution: bundler`, `strict`, `noUncheckedIndexedAccess`.
- All `u64` values (`fx_rate`, `fx_pyth_publish_time_ms`) stay `bigint` end-to-end → `tx.pure.u64(bigint)`. NEVER downcast to JS `number`.
- `@mysten/sui` pinned to known-good `^1.x` (Transaction rename + `tx.pure.*` builders are version-sensitive).
- Tests assert PTB structure via `tx.getData()` and/or `tx.build({ onlyTransactionKind: true })`. NEVER call plain `tx.build()` in Phase A (unresolved refs throw).
- `pay_one` PTB argument order (10 args, `ctx` auto-injected, payroll.move:211-223): payroll, ownerCap, escrow, scallop, navi, employee(address), fx_pair(vector<u8>), fx_rate(u64), fx_pyth_publish_time(u64), clock.
- `MAX_BATCH = 50` is a provisional object-mutation budget (spec §13), calibrated later in Phase C.
- Test WHY-comments required (Rule 9): each test states why the behavior matters.

---

### Task 1: Dependency + types

**Files:**
- Modify: `ts/package.json` (add `@mysten/sui`)
- Create: `ts/src/payday/types.ts`

**Interfaces:**
- Consumes: `FxPair`, `FxScalars` from `../fx/types.js`.
- Produces: `PaydayEmployee`, `PaydayConfig`, `PaydayChunk`, `PaydayPlan`, `DuplicatePayee`, `MissingFxScalars`, `FxPairLabelMismatch`, `MAX_BATCH`.

- [ ] **Step 1: Add the dependency**

Run: `cd ts && pnpm add '@mysten/sui@^1'`
Expected: `package.json` gains `"@mysten/sui": "^1.x"`; lockfile updates; exit 0.

- [ ] **Step 2: Create `ts/src/payday/types.ts`**

```ts
import type { Transaction } from "@mysten/sui/transactions";
import type { FxPair, FxScalars } from "../fx/types.js";

/** Provisional object-mutation budget per PTB (spec §13); Phase C calibrates the real ceiling. */
export const MAX_BATCH = 50;

/** A payee for one payday: address + the currency pair their compliance event is denominated in. */
export interface PaydayEmployee {
  addr: string;   // 0x-prefixed Sui address
  pair: FxPair;
}

/** Pinned on-chain handles + type tag the builder needs. All resolution deferred to Phase B. */
export interface PaydayConfig {
  packageId: string;
  coinType: string;   // T type arg for pay_one<T> (full coin type tag)
  payrollId: string;
  ownerCapId: string;
  escrowId: string;
  scallopId: string;  // canonical mainnet vault ID — pinned (spec §2)
  naviId: string;
  clockId: string;    // 0x6
}

export interface PaydayChunk {
  employees: string[];      // addresses in this chunk, in order
  hasBeginPeriod: boolean;  // true only for chunk[0]
}

export interface PaydayPlan {
  transactions: Transaction[];
  chunks: PaydayChunk[];
}

/** Re-export for callers assembling the per-pair scalar map. */
export type { FxPair, FxScalars };

export class DuplicatePayee extends Error {}      // same address twice in one buildPayday
export class MissingFxScalars extends Error {}    // employee.pair absent from fxByPair
export class FxPairLabelMismatch extends Error {} // fxByPair scalars' fx_pair bytes != employee.pair
```

- [ ] **Step 3: Type-check**

Run: `cd ts && pnpm build`
Expected: PASS (tsc `--noEmit`, no errors).

- [ ] **Step 4: Commit**

```bash
git add ts/package.json ts/pnpm-lock.yaml ts/src/payday/types.ts
git commit -m "feat(ts): #8 payday builder types + @mysten/sui dep"
```

---

### Task 2: Pure chunker

**Files:**
- Create: `ts/src/payday/chunk.ts`
- Test: `ts/test/payday/chunk.test.ts`

**Interfaces:**
- Produces: `chunk<T>(items: readonly T[], size: number): T[][]`.

- [ ] **Step 1: Write the failing test**

```ts
// ts/test/payday/chunk.test.ts
import { describe, it, expect } from "vitest";
import { chunk } from "../../src/payday/chunk.js";

describe("chunk", () => {
  // WHY: payday batch boundaries map 1:1 to PTBs; a wrong split over/under-fills a PTB
  // and breaks the spec §13 object-mutation budget.
  it("empty input -> no chunks", () => {
    expect(chunk([], 50)).toEqual([]);
  });
  it("exact multiple -> full chunks", () => {
    expect(chunk(Array.from({ length: 100 }, (_, i) => i), 50).map((c) => c.length)).toEqual([50, 50]);
  });
  it("remainder -> trailing short chunk", () => {
    expect(chunk(Array.from({ length: 51 }, (_, i) => i), 50).map((c) => c.length)).toEqual([50, 1]);
  });
  it("single chunk when under size", () => {
    expect(chunk([1], 50).map((c) => c.length)).toEqual([1]);
  });
  it("preserves order", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
  it("rejects non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ts && pnpm vitest run test/payday/chunk.test.ts`
Expected: FAIL — cannot resolve `../../src/payday/chunk.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ts/src/payday/chunk.ts
/** Split into order-preserving batches of at most `size`. Pure. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError(`size must be > 0, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ts && pnpm vitest run test/payday/chunk.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ts/src/payday/chunk.ts ts/test/payday/chunk.test.ts
git commit -m "feat(ts): #8 pure order-preserving chunker (TDD)"
```

---

### Task 3: Invariant guards (FX + dup checks)

**Files:**
- Create: `ts/src/payday/build.ts` (validation helper only this task)
- Test: `ts/test/payday/build.test.ts` (invariant cases)

**Interfaces:**
- Consumes: `PaydayEmployee`, `FxScalars`, `DuplicatePayee`, `MissingFxScalars`, `FxPairLabelMismatch` from `./types.js`.
- Produces: `assertPaydayInputs(employees: readonly PaydayEmployee[], fxByPair: ReadonlyMap<string, FxScalars>): void`.

- [ ] **Step 1: Write the failing test**

```ts
// ts/test/payday/build.test.ts
import { describe, it, expect } from "vitest";
import { assertPaydayInputs } from "../../src/payday/build.js";
import { DuplicatePayee, MissingFxScalars, FxPairLabelMismatch } from "../../src/payday/types.js";
import type { FxScalars } from "../../src/fx/types.js";

const scalars = (pair: string): FxScalars => ({
  fx_pair: new TextEncoder().encode(pair),
  fx_rate: 1_085_000_000n,
  fx_pyth_publish_time_ms: 1_700_000_000_000n,
});
const fxMap = new Map<string, FxScalars>([["EUR/USD", scalars("EUR/USD")]]);

describe("assertPaydayInputs", () => {
  // WHY: silently skipping or mislabeling a payee corrupts the on-chain compliance event
  // the auditor relies on — the operator invariant from move-notes open-task #4.
  it("accepts well-formed inputs", () => {
    expect(() => assertPaydayInputs([{ addr: "0x1", pair: "EUR/USD" }], fxMap)).not.toThrow();
  });
  it("rejects duplicate payee address (would abort whole PTB on-chain)", () => {
    expect(() =>
      assertPaydayInputs(
        [{ addr: "0x1", pair: "EUR/USD" }, { addr: "0x1", pair: "EUR/USD" }],
        fxMap,
      ),
    ).toThrow(DuplicatePayee);
  });
  it("rejects employee whose pair has no scalars (never skip a payee)", () => {
    expect(() => assertPaydayInputs([{ addr: "0x1", pair: "GBP/USD" }], fxMap)).toThrow(MissingFxScalars);
  });
  it("rejects scalars whose fx_pair bytes mismatch the employee pair", () => {
    const bad = new Map<string, FxScalars>([["EUR/USD", scalars("GBP/USD")]]);
    expect(() => assertPaydayInputs([{ addr: "0x1", pair: "EUR/USD" }], bad)).toThrow(FxPairLabelMismatch);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ts && pnpm vitest run test/payday/build.test.ts`
Expected: FAIL — `assertPaydayInputs` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// ts/src/payday/build.ts
import type { FxScalars } from "../fx/types.js";
import {
  type PaydayEmployee,
  DuplicatePayee,
  MissingFxScalars,
  FxPairLabelMismatch,
} from "./types.js";

const decoder = new TextDecoder();

/** Fail-loud preflight: no dup payees, every pair has scalars, every label matches its bytes. */
export function assertPaydayInputs(
  employees: readonly PaydayEmployee[],
  fxByPair: ReadonlyMap<string, FxScalars>,
): void {
  const seen = new Set<string>();
  for (const e of employees) {
    if (seen.has(e.addr)) throw new DuplicatePayee(`payee ${e.addr} appears twice`);
    seen.add(e.addr);
    const fx = fxByPair.get(e.pair);
    if (!fx) throw new MissingFxScalars(`no fx scalars for pair ${e.pair}`);
    if (decoder.decode(fx.fx_pair) !== e.pair) {
      throw new FxPairLabelMismatch(`scalars for ${e.pair} carry label ${decoder.decode(fx.fx_pair)}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ts && pnpm vitest run test/payday/build.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ts/src/payday/build.ts ts/test/payday/build.test.ts
git commit -m "feat(ts): #8 payday input invariant guards (TDD)"
```

---

### Task 4: `buildPayday` PTB assembly

**Files:**
- Modify: `ts/src/payday/build.ts` (add `buildPayday` + private `appendPayOne` / `appendBeginPeriod`)
- Test: `ts/test/payday/build.test.ts` (add assembly cases)

**Interfaces:**
- Consumes: `chunk` from `./chunk.js`; `assertPaydayInputs` (Task 3); `PaydayEmployee`, `PaydayConfig`, `PaydayPlan`, `MAX_BATCH`, `FxScalars` from `./types.js`/`../fx/types.js`; `Transaction` from `@mysten/sui/transactions`.
- Produces: `buildPayday(employees: readonly PaydayEmployee[], fxByPair: ReadonlyMap<string, FxScalars>, config: PaydayConfig): PaydayPlan`.

- [ ] **Step 1: Write the failing tests**

Append to `ts/test/payday/build.test.ts`:

```ts
import { buildPayday } from "../../src/payday/build.js";
import type { PaydayConfig, PaydayEmployee } from "../../src/payday/types.js";

const cfg: PaydayConfig = {
  packageId: "0xpkg", coinType: "0xpkg::usdc::USDC",
  payrollId: "0xpay", ownerCapId: "0xcap", escrowId: "0xesc",
  scallopId: "0xsca", naviId: "0xnav", clockId: "0x6",
};
const emps = (n: number): PaydayEmployee[] =>
  Array.from({ length: n }, (_, i) => ({ addr: `0x${(i + 1).toString(16)}`, pair: "EUR/USD" as const }));

// reuse fxMap/scalars from earlier in this file
function commands(tx: import("@mysten/sui/transactions").Transaction) {
  return tx.getData().commands;
}
function moveTargets(tx: import("@mysten/sui/transactions").Transaction): string[] {
  return commands(tx)
    .filter((c): c is Extract<typeof c, { MoveCall: unknown }> => "MoveCall" in c)
    .map((c) => `${c.MoveCall.package}::${c.MoveCall.module}::${c.MoveCall.function}`);
}

describe("buildPayday", () => {
  // WHY: chunk count == PTB count; a miscount silently drops or doubles payees.
  it("0 employees -> empty plan, no spurious begin_period", () => {
    const plan = buildPayday([], fxMap, cfg);
    expect(plan.transactions).toEqual([]);
    expect(plan.chunks).toEqual([]);
  });
  it("51 employees -> 2 chunks [50,1]", () => {
    const plan = buildPayday(emps(51), fxMap, cfg);
    expect(plan.chunks.map((c) => c.employees.length)).toEqual([50, 1]);
  });
  // WHY: begin_period must run exactly once per payday, in the first PTB only;
  // a second begin_period double-advances the period (spec D10).
  it("prepends begin_period to chunk[0] only", () => {
    const plan = buildPayday(emps(51), fxMap, cfg);
    expect(plan.chunks[0]!.hasBeginPeriod).toBe(true);
    expect(plan.chunks[1]!.hasBeginPeriod).toBe(false);
    expect(moveTargets(plan.transactions[0]!)[0]).toBe("0xpkg::payroll::begin_period");
    expect(moveTargets(plan.transactions[1]!).every((t) => t.endsWith("::pay_one"))).toBe(true);
  });
  it("chunk[0] has begin_period + one pay_one per employee", () => {
    const plan = buildPayday(emps(3), fxMap, cfg);
    const t = moveTargets(plan.transactions[0]!);
    expect(t[0]).toBe("0xpkg::payroll::begin_period");
    expect(t.filter((x) => x.endsWith("::pay_one")).length).toBe(3);
  });
  // WHY: bigint discipline exists because publish_time (~1.7e12) loses precision as a JS number;
  // the u64 input must round-trip exactly.
  it("encodes fx_rate as u64 without precision loss", () => {
    const big = 18_446_744_073_709_551_615n; // u64::MAX
    const fx = new Map([["EUR/USD", { fx_pair: new TextEncoder().encode("EUR/USD"), fx_rate: big, fx_pyth_publish_time_ms: 1_700_000_000_000n }]]);
    const plan = buildPayday([{ addr: "0x1", pair: "EUR/USD" }], fx, cfg);
    const inputs = plan.transactions[0]!.getData().inputs;
    // u64::MAX little-endian bytes present among pure inputs
    const hasMax = inputs.some((i) => i.Pure && Buffer.from(i.Pure.bytes, "base64").equals(Buffer.from("ffffffffffffffff", "hex")));
    expect(hasMax).toBe(true);
  });
  it("propagates invariant failures (duplicate payee)", () => {
    expect(() => buildPayday([{ addr: "0x1", pair: "EUR/USD" }, { addr: "0x1", pair: "EUR/USD" }], fxMap, cfg)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ts && pnpm vitest run test/payday/build.test.ts`
Expected: FAIL — `buildPayday` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `ts/src/payday/build.ts`:

```ts
import { Transaction } from "@mysten/sui/transactions";
import { chunk } from "./chunk.js";
import { type PaydayConfig, type PaydayPlan, MAX_BATCH } from "./types.js";

function appendBeginPeriod(tx: Transaction, cfg: PaydayConfig): void {
  tx.moveCall({
    target: `${cfg.packageId}::payroll::begin_period`,
    typeArguments: [cfg.coinType],
    arguments: [tx.object(cfg.payrollId), tx.object(cfg.ownerCapId)],
  });
}

function appendPayOne(tx: Transaction, cfg: PaydayConfig, addr: string, fx: FxScalars): void {
  tx.moveCall({
    target: `${cfg.packageId}::payroll::pay_one`,
    typeArguments: [cfg.coinType],
    arguments: [
      tx.object(cfg.payrollId),
      tx.object(cfg.ownerCapId),
      tx.object(cfg.escrowId),
      tx.object(cfg.scallopId),
      tx.object(cfg.naviId),
      tx.pure.address(addr),
      tx.pure.vector("u8", [...fx.fx_pair]),
      tx.pure.u64(fx.fx_rate),
      tx.pure.u64(fx.fx_pyth_publish_time_ms),
      tx.object(cfg.clockId),
    ],
  });
}

/**
 * Build the PTBs for one payday. PURE: no signing, no submission, no chain reads — the returned
 * Transactions carry UNRESOLVED shared/owned object refs (a Phase B executor resolves them).
 *
 * CONTRACT: one call == one fresh payday. begin_period is prepended to chunk[0] only and advances
 * the period; re-running advances it again. transactions[] order == mandatory submission order, and
 * transactions[0] must be confirmed on-chain before submitting the rest (begin_period must land, and
 * owned-object versions for cap/gas must be re-fetched between chunks to avoid equivocation).
 */
export function buildPayday(
  employees: readonly PaydayEmployee[],
  fxByPair: ReadonlyMap<string, FxScalars>,
  config: PaydayConfig,
): PaydayPlan {
  assertPaydayInputs(employees, fxByPair);
  const batches = chunk(employees, MAX_BATCH);
  const plan: PaydayPlan = { transactions: [], chunks: [] };
  batches.forEach((batch, idx) => {
    const tx = new Transaction();
    const hasBeginPeriod = idx === 0;
    if (hasBeginPeriod) appendBeginPeriod(tx, config);
    for (const e of batch) {
      appendPayOne(tx, config, e.addr, fxByPair.get(e.pair)!); // presence asserted above
    }
    plan.transactions.push(tx);
    plan.chunks.push({ employees: batch.map((e) => e.addr), hasBeginPeriod });
  });
  return plan;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ts && pnpm vitest run test/payday/build.test.ts`
Expected: PASS (all assembly + invariant tests).

- [ ] **Step 5: Type-check whole package**

Run: `cd ts && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ts/src/payday/build.ts ts/test/payday/build.test.ts
git commit -m "feat(ts): #8 buildPayday PTB assembly (chunked, begin_period once) (TDD)"
```

---

### Task 5: Full suite + monkey edge cases

**Files:**
- Test: `ts/test/payday/build.test.ts` (add boundary cases)

**Interfaces:**
- Consumes: everything above. No new exports.

- [ ] **Step 1: Add boundary tests**

Append to `ts/test/payday/build.test.ts`:

```ts
describe("buildPayday boundaries (monkey)", () => {
  // WHY: 50 is the object-budget boundary; off-by-one here is exactly what overflows a PTB.
  it("exactly 50 -> single chunk with begin_period", () => {
    const plan = buildPayday(emps(50), fxMap, cfg);
    expect(plan.chunks.map((c) => c.employees.length)).toEqual([50]);
    expect(plan.chunks[0]!.hasBeginPeriod).toBe(true);
  });
  it("100 -> [50,50], only first carries begin_period", () => {
    const plan = buildPayday(emps(100), fxMap, cfg);
    expect(plan.chunks.map((c) => c.employees.length)).toEqual([50, 50]);
    expect(plan.chunks.map((c) => c.hasBeginPeriod)).toEqual([true, false]);
  });
  // WHY: pay_one takes 10 PTB args in a fixed order; a missing/extra arg is a silent abort on-chain.
  it("each pay_one carries exactly 10 arguments", () => {
    const plan = buildPayday(emps(1), fxMap, cfg);
    const cmds = plan.transactions[0]!.getData().commands;
    const payOne = cmds.find((c) => "MoveCall" in c && c.MoveCall.function === "pay_one")!;
    expect((payOne as any).MoveCall.arguments.length).toBe(10);
  });
});
```

- [ ] **Step 2: Run the full payday suite**

Run: `cd ts && pnpm vitest run test/payday`
Expected: PASS (all chunk + build + boundary tests).

- [ ] **Step 3: Run the entire package suite (no regressions in fx)**

Run: `cd ts && pnpm test`
Expected: PASS (existing 14 fx tests + new payday tests).

- [ ] **Step 4: Final type-check**

Run: `cd ts && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ts/test/payday/build.test.ts
git commit -m "test(ts): #8 payday builder boundary/monkey cases (50/100, arg arity)"
```

---

## Notes for the implementer

- The exact shape of `tx.getData().commands` / `.inputs` and the `MoveCall` discriminator come from `@mysten/sui`'s `TransactionData` type. If the discriminator key differs in the installed version (e.g. `$kind`), adjust the test helpers (`moveTargets`, arg-arity) to match — the assertions (target strings, arg count, begin_period position) stay the same. Verify against the installed version, do not trust this doc's field names blindly.
- If `pnpm add '@mysten/sui@^1'` resolves to a 2.x major later, pin explicitly to the latest 1.x and note it in the commit.
- Do NOT call plain `tx.build()` anywhere in tests (unresolved refs throw). `getData()` is sufficient for all structural assertions here.
