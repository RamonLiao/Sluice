# Payday Executor (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `executePayday()` — the Phase B executor that signs, submits, and confirms the unresolved `Transaction`s from Phase A's `buildPayday()`, sequentially and resume-safely, returning auditable receipts.

**Architecture:** Pure orchestration over a narrow injected `PaydayClient` port (prod = `SuiGrpcClient` adapter; tests = mock). One chunk at a time: optional dryRun preflight → sign+execute → wait-for-confirm → next. `begin_period` non-idempotence makes resume a double-pay safety boundary, guarded by `resumeFrom` + optional `expectedPeriod`. Fail-stop on any chunk failure; no state held (caller persists `PaydayResult`).

**Tech Stack:** TypeScript (strict, ESM), `@mysten/sui@1.45.2` (`Transaction`, `@mysten/sui/grpc`), vitest. Package `ts/` (`@payroll-flow/orchestrator`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-20-payday-executor-design.md` (authoritative).
- Pin `@mysten/sui@^1.45.2` — NO version bump. It already ships `@mysten/sui/grpc`. (Spec "SDK transport decision".)
- Prod adapter targets `SuiGrpcClient` + `client.core.*`, never legacy JSON-RPC `SuiClient`. (Spec §2 adapter mapping.)
- Status check uses the core-API discriminator `res.kind === "FailedTransaction"`, never `effects.status`. (Spec §2.)
- `dryRunTransaction(tx)` takes NO signer; executor calls `tx.setSender(signer.toSuiAddress())` before dryRun/execute. (Spec §2.)
- Never pre-build/pre-sign all chunks — resolve each just-in-time after the prior confirms (H2/H2b). (Spec §2.)
- `begin_period` lives only on `transactions[0]`; runs only when `resumeFrom === 0`. (Spec safety section.)
- No changes to Phase A files (`build.ts`/`chunk.ts`/`types.ts`) or any `.move` source. (Spec "Files".)
- Tests inject a mock `PaydayClient`; no real chain. Tests encode WHY (Rule 9). (Spec §4.)

---

### Task 1: Types + period safety gate

**Files:**
- Create: `ts/src/payday/execute-types.ts`
- Create: `ts/src/payday/execute.ts` (only `assertPeriodGate` in this task)
- Test: `ts/test/payday/execute.test.ts` (gate describe block)

**Interfaces:**
- Consumes: nothing (new module).
- Produces:
  - `interface PaydaySigner { toSuiAddress(): string }`
  - `interface DryRunResult { ok: boolean; error: string | null }`
  - `interface ExecResult { kind: "success" | "FailedTransaction"; digest: string; error: string | null; gasUsed: bigint | null }`
  - `interface PaydayClient { getCurrentPeriod(payrollId: string): Promise<bigint>; dryRunTransaction(tx: Transaction): Promise<DryRunResult>; signAndExecute(tx: Transaction, signer: PaydaySigner): Promise<ExecResult>; waitForConfirm(digest: string): Promise<void> }`
  - `interface ChunkReceipt { chunkIndex: number; digest: string | null; status: "success" | "failure" | "skipped"; employees: string[]; paidAtPeriod: bigint | null; gasUsed: bigint | null; error: string | null }`
  - `interface PaydayResult { receipts: ChunkReceipt[]; completed: boolean; nextResumeFrom: number | null }`
  - `interface ExecutePaydayOpts { resumeFrom?: number; expectedPeriod?: bigint; preflight?: boolean }`
  - `class PeriodGateError extends Error {}` , `class ResumeRangeError extends Error {}`
  - `function assertPeriodGate(currentPeriod: bigint, resumeFrom: number, expectedPeriod?: bigint): void`

- [ ] **Step 1: Write `execute-types.ts`** (no test — pure type declarations consumed by later steps)

```ts
import type { Transaction } from "@mysten/sui/transactions";

/** Minimal signer surface the executor needs; a real @mysten/sui Signer/Keypair satisfies it. */
export interface PaydaySigner {
  toSuiAddress(): string;
}

export interface DryRunResult {
  ok: boolean;
  error: string | null;
}

export interface ExecResult {
  kind: "success" | "FailedTransaction"; // core-API discriminator (NOT effects.status)
  digest: string;
  error: string | null;
  gasUsed: bigint | null;
}

/** Narrow port over the chain. Prod = SuiGrpcClient adapter; tests = mock. */
export interface PaydayClient {
  getCurrentPeriod(payrollId: string): Promise<bigint>;
  dryRunTransaction(tx: Transaction): Promise<DryRunResult>; // no signer; sender set on tx by executor
  signAndExecute(tx: Transaction, signer: PaydaySigner): Promise<ExecResult>;
  waitForConfirm(digest: string): Promise<void>;
}

export interface ChunkReceipt {
  chunkIndex: number;
  digest: string | null;        // null = dryRun-failed / never submitted
  status: "success" | "failure" | "skipped"; // skipped = not attempted this run
  employees: string[];
  paidAtPeriod: bigint | null;  // the payday's period at confirm time (audit)
  gasUsed: bigint | null;
  error: string | null;
}

export interface PaydayResult {
  receipts: ChunkReceipt[];     // one per chunk, aligned to plan.chunks
  completed: boolean;
  nextResumeFrom: number | null;
}

export interface ExecutePaydayOpts {
  resumeFrom?: number;
  expectedPeriod?: bigint;
  preflight?: boolean;
}

export class PeriodGateError extends Error {}
export class ResumeRangeError extends Error {}
```

- [ ] **Step 2: Write the failing test** for `assertPeriodGate`

```ts
import { describe, it, expect } from "vitest";
import { assertPeriodGate } from "../../src/payday/execute.js";
import { PeriodGateError } from "../../src/payday/execute-types.js";

describe("assertPeriodGate", () => {
  it("no expectedPeriod => no gate (demo mode)", () => {
    expect(() => assertPeriodGate(5n, 0)).not.toThrow();
    expect(() => assertPeriodGate(5n, 3)).not.toThrow();
  });

  it("fresh run requires current_period === expectedPeriod - 1 (begin_period will advance it)", () => {
    expect(() => assertPeriodGate(0n, 0, 1n)).not.toThrow(); // chain at 0, paying period 1
  });

  it("fresh run throws if begin_period already ran (double-pay risk)", () => {
    // chain already at 1 but caller thinks this is a fresh payday for period 1:
    // re-running begin_period would open period 2 and re-pay everyone -> reject.
    expect(() => assertPeriodGate(1n, 0, 1n)).toThrow(PeriodGateError);
  });

  it("resume requires current_period === expectedPeriod (begin_period already landed)", () => {
    expect(() => assertPeriodGate(1n, 2, 1n)).not.toThrow();
    expect(() => assertPeriodGate(0n, 2, 1n)).toThrow(PeriodGateError); // period not advanced -> drift
    expect(() => assertPeriodGate(2n, 2, 1n)).toThrow(PeriodGateError); // advanced too far -> drift
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ts && npx vitest run test/payday/execute.test.ts -t assertPeriodGate`
Expected: FAIL — `assertPeriodGate` is not exported / not a function.

- [ ] **Step 4: Implement `assertPeriodGate` in `execute.ts`**

```ts
import { PeriodGateError } from "./execute-types.js";

/**
 * Guard against begin_period double-pay. begin_period is NOT idempotent (payroll.move:176-180):
 * re-running it opens a new period and would re-pay already-paid employees. expectedPeriod turns
 * "this is payday N" into a chain-checkable precondition. Omit it to skip the gate (demo mode).
 */
export function assertPeriodGate(
  currentPeriod: bigint,
  resumeFrom: number,
  expectedPeriod?: bigint,
): void {
  if (expectedPeriod === undefined) return;
  if (resumeFrom === 0) {
    if (currentPeriod !== expectedPeriod - 1n) {
      throw new PeriodGateError(
        `fresh run expects current_period ${expectedPeriod - 1n}, chain at ${currentPeriod} — ` +
          `begin_period may have already run for this payday (double-pay risk)`,
      );
    }
  } else if (currentPeriod !== expectedPeriod) {
    throw new PeriodGateError(
      `resume expects current_period ${expectedPeriod}, chain at ${currentPeriod} — state drift`,
    );
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ts && npx vitest run test/payday/execute.test.ts -t assertPeriodGate`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add ts/src/payday/execute-types.ts ts/src/payday/execute.ts ts/test/payday/execute.test.ts
git commit -m "feat(ts): #8 Phase B executor types + period safety gate (TDD)"
```

---

### Task 2: `executePayday` happy path + H2 ordering

**Files:**
- Modify: `ts/src/payday/execute.ts` (add `executePayday`)
- Test: `ts/test/payday/execute.test.ts` (add mock harness + happy/ordering blocks)

**Interfaces:**
- Consumes: `assertPeriodGate`, all types from Task 1; `PaydayPlan` from `./types.js`; `Transaction` from `@mysten/sui/transactions`.
- Produces: `async function executePayday(plan: PaydayPlan, payrollId: string, signer: PaydaySigner, client: PaydayClient, opts?: ExecutePaydayOpts): Promise<PaydayResult>`
- Produces (test helpers, exported only within the test file): `makePlan(chunkCount)`, `makeMockClient(opts)` returning `{ client, calls }`.

- [ ] **Step 1: Add the mock harness + failing happy-path/ordering tests**

Append to `ts/test/payday/execute.test.ts`:

```ts
import { Transaction } from "@mysten/sui/transactions";
import { executePayday } from "../../src/payday/execute.js";
import type { PaydayClient, PaydaySigner } from "../../src/payday/execute-types.js";
import type { PaydayPlan } from "../../src/payday/types.js";

const ADDR = "0x" + "a".repeat(64);
const signer: PaydaySigner = { toSuiAddress: () => ADDR };

function makePlan(chunkCount: number): PaydayPlan {
  const transactions: Transaction[] = [];
  const chunks: PaydayPlan["chunks"] = [];
  for (let i = 0; i < chunkCount; i++) {
    transactions.push(new Transaction());
    chunks.push({ employees: ["0x" + String(i).padStart(64, "0")], hasBeginPeriod: i === 0 });
  }
  return { transactions, chunks };
}

interface MockOpts {
  currentPeriod?: bigint;
  failExecAt?: number;  // 0-based index AMONG signAndExecute calls that returns FailedTransaction
  dryRunOk?: boolean;
  throwWaitAt?: number; // 0-based index among waitForConfirm calls that throws
}

function makeMockClient(opts: MockOpts = {}) {
  const calls: string[] = [];
  let execN = 0;
  let waitN = 0;
  const client: PaydayClient = {
    async getCurrentPeriod() {
      calls.push("getCurrentPeriod");
      return opts.currentPeriod ?? 0n;
    },
    async dryRunTransaction() {
      calls.push("dryRun");
      const ok = opts.dryRunOk ?? true;
      return { ok, error: ok ? null : "simulated abort" };
    },
    async signAndExecute() {
      const idx = execN++;
      calls.push(`exec:${idx}`);
      const failed = opts.failExecAt === idx;
      return {
        kind: failed ? "FailedTransaction" : "success",
        digest: `dig${idx}`,
        error: failed ? "MoveAbort 11" : null,
        gasUsed: failed ? null : 1000n,
      };
    },
    async waitForConfirm() {
      const idx = waitN++;
      calls.push(`wait:${idx}`);
      if (opts.throwWaitAt === idx) throw new Error("wait timeout");
    },
  };
  return { client, calls };
}

describe("executePayday — happy path", () => {
  it("runs all chunks, returns success receipts + completed", async () => {
    const { client, calls } = makeMockClient();
    const plan = makePlan(3);
    const res = await executePayday(plan, "0xpayroll", signer, client, { preflight: false });

    expect(res.completed).toBe(true);
    expect(res.nextResumeFrom).toBeNull();
    expect(res.receipts.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(res.receipts.map((r) => r.digest)).toEqual(["dig0", "dig1", "dig2"]);
    expect(res.receipts.every((r) => r.gasUsed === 1000n)).toBe(true);
    // WHY: every chunk in one payday is paid at the same period (begin_period runs once).
    // fresh run: chain at 0 -> payday period 1.
    expect(res.receipts.every((r) => r.paidAtPeriod === 1n)).toBe(true);
    expect(calls).toContain("exec:2");
  });
});

describe("executePayday — H2 sequential ordering", () => {
  it("never sends chunk[i+1] before chunk[i] confirms (defends EAlreadyPaidThisPeriod / equivocation)", async () => {
    const { client, calls } = makeMockClient();
    const plan = makePlan(3);
    await executePayday(plan, "0xpayroll", signer, client, { preflight: false });

    // exec:i MUST be immediately followed by wait:i, before exec:(i+1).
    const order = calls.filter((c) => c.startsWith("exec") || c.startsWith("wait"));
    expect(order).toEqual(["exec:0", "wait:0", "exec:1", "wait:1", "exec:2", "wait:2"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ts && npx vitest run test/payday/execute.test.ts -t executePayday`
Expected: FAIL — `executePayday` is not exported.

- [ ] **Step 3: Implement `executePayday`** (append to `execute.ts`)

```ts
import type { Transaction } from "@mysten/sui/transactions";
import type { PaydayPlan } from "./types.js";
import {
  type PaydayClient,
  type PaydaySigner,
  type PaydayResult,
  type ChunkReceipt,
  type ExecutePaydayOpts,
  ResumeRangeError,
} from "./execute-types.js";

/**
 * Execute one payday. Sequential, resume-safe, fail-stop. Holds no state — the caller
 * persists the returned PaydayResult and on the next run passes resumeFrom = nextResumeFrom.
 * Never pre-builds chunks: each tx is resolved/signed only after the prior one confirms (H2/H2b).
 */
export async function executePayday(
  plan: PaydayPlan,
  payrollId: string,
  signer: PaydaySigner,
  client: PaydayClient,
  opts: ExecutePaydayOpts = {},
): Promise<PaydayResult> {
  const { resumeFrom = 0, expectedPeriod, preflight = true } = opts;
  const n = plan.transactions.length;

  if (!Number.isInteger(resumeFrom) || resumeFrom < 0 || resumeFrom > n) {
    throw new ResumeRangeError(`resumeFrom ${resumeFrom} out of range [0, ${n}]`);
  }

  const receipts: ChunkReceipt[] = plan.chunks.map((c, i) => ({
    chunkIndex: i,
    digest: null,
    status: "skipped",
    employees: c.employees,
    paidAtPeriod: null,
    gasUsed: null,
    error: null,
  }));

  const currentPeriod = await client.getCurrentPeriod(payrollId);
  assertPeriodGate(currentPeriod, resumeFrom, expectedPeriod);
  // begin_period runs once (chunk[0]); a resumed run already advanced the period.
  const paydayPeriod = resumeFrom === 0 ? currentPeriod + 1n : currentPeriod;

  for (let i = resumeFrom; i < n; i++) {
    const tx: Transaction = plan.transactions[i]!;
    tx.setSender(signer.toSuiAddress()); // required for simulate; binds sender == signer (H3)

    if (i === resumeFrom && preflight) {
      const dry = await client.dryRunTransaction(tx);
      if (!dry.ok) {
        receipts[i] = { ...receipts[i]!, status: "failure", error: dry.error ?? "dryRun failed" };
        return { receipts, completed: false, nextResumeFrom: i };
      }
    }

    const res = await client.signAndExecute(tx, signer);
    await client.waitForConfirm(res.digest); // H2: confirm before next chunk is even built

    if (res.kind === "FailedTransaction") {
      receipts[i] = { ...receipts[i]!, digest: res.digest, status: "failure", error: res.error };
      return { receipts, completed: false, nextResumeFrom: i }; // fail-stop
    }

    receipts[i] = {
      ...receipts[i]!,
      digest: res.digest,
      status: "success",
      paidAtPeriod: paydayPeriod,
      gasUsed: res.gasUsed,
    };
  }

  return { receipts, completed: true, nextResumeFrom: null };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ts && npx vitest run test/payday/execute.test.ts -t executePayday`
Expected: PASS (happy path + ordering).

- [ ] **Step 5: Commit**

```bash
git add ts/src/payday/execute.ts ts/test/payday/execute.test.ts
git commit -m "feat(ts): #8 Phase B executePayday happy path + H2 sequential ordering (TDD)"
```

---

### Task 3: Fail-stop + dryRun preflight

**Files:**
- Test: `ts/test/payday/execute.test.ts` (add fail-stop + preflight blocks)
- (No `execute.ts` change expected — Task 2 already implemented both paths; these tests lock the behavior.)

**Interfaces:**
- Consumes: `executePayday`, `makePlan`, `makeMockClient` from Tasks 1-2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```ts
describe("executePayday — fail-stop", () => {
  it("stops at first failed chunk, never submits later chunks, sets nextResumeFrom", async () => {
    const { client, calls } = makeMockClient({ failExecAt: 1 });
    const plan = makePlan(3);
    const res = await executePayday(plan, "0xpayroll", signer, client, { preflight: false });

    expect(res.completed).toBe(false);
    expect(res.nextResumeFrom).toBe(1);
    expect(res.receipts.map((r) => r.status)).toEqual(["success", "failure", "skipped"]);
    expect(res.receipts[1]!.error).toBe("MoveAbort 11");
    // WHY: money fails loud — chunk[2] must NEVER be submitted after chunk[1] aborts.
    expect(calls).not.toContain("exec:2");
  });
});

describe("executePayday — dryRun preflight", () => {
  it("aborts before any money moves when preflight dryRun fails", async () => {
    const { client, calls } = makeMockClient({ dryRunOk: false });
    const plan = makePlan(3);
    const res = await executePayday(plan, "0xpayroll", signer, client, { preflight: true });

    expect(res.completed).toBe(false);
    expect(res.nextResumeFrom).toBe(0);
    expect(res.receipts[0]!.status).toBe("failure");
    expect(res.receipts[0]!.error).toBe("simulated abort");
    // WHY: zero submissions — dryRun is the pre-money insurance gate.
    expect(calls.filter((c) => c.startsWith("exec"))).toEqual([]);
  });

  it("preflight dryRuns only the resumeFrom chunk, not every chunk", async () => {
    const { client, calls } = makeMockClient();
    const plan = makePlan(3);
    await executePayday(plan, "0xpayroll", signer, client, { preflight: true });
    expect(calls.filter((c) => c === "dryRun").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify** (should PASS immediately — Task 2 implemented these paths)

Run: `cd ts && npx vitest run test/payday/execute.test.ts -t "fail-stop"` and `-t "preflight"`
Expected: PASS. If any FAIL, fix `execute.ts` to match the spec'd behavior (fail-stop returns at the failing index; preflight only on `i === resumeFrom`).

- [ ] **Step 3: Commit**

```bash
git add ts/test/payday/execute.test.ts
git commit -m "test(ts): #8 Phase B fail-stop + dryRun preflight gate (TDD)"
```

---

### Task 4: Resume (no begin_period re-run) + double-pay gate integration

**Files:**
- Test: `ts/test/payday/execute.test.ts` (add resume + gate-integration blocks)

**Interfaces:**
- Consumes: `executePayday`, helpers, `PeriodGateError` from earlier tasks.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```ts
import { PeriodGateError } from "../../src/payday/execute-types.js";

describe("executePayday — resume", () => {
  it("resumeFrom=2 marks earlier chunks skipped and submits only chunk[2]", async () => {
    // chain already at period 1 (begin_period landed in a prior session).
    const { client, calls } = makeMockClient({ currentPeriod: 1n });
    const plan = makePlan(3);
    const res = await executePayday(plan, "0xpayroll", signer, client, {
      resumeFrom: 2,
      preflight: false,
    });

    expect(res.completed).toBe(true);
    expect(res.receipts.map((r) => r.status)).toEqual(["skipped", "skipped", "success"]);
    // WHY: only one exec call, and it is the FIRST exec (chunk 0/1 never re-run -> begin_period not re-run).
    expect(calls.filter((c) => c.startsWith("exec"))).toEqual(["exec:0"]);
    // resumed payday pays at the already-advanced period 1 (NOT 2).
    expect(res.receipts[2]!.paidAtPeriod).toBe(1n);
  });
});

describe("executePayday — double-pay gate integration", () => {
  it("throws PeriodGateError on fresh re-run when begin_period already advanced the period", async () => {
    // caller thinks fresh payday for period 1, but chain is already at 1 -> re-running begin_period
    // would open period 2 and re-pay everyone. Reject before any submission.
    const { client, calls } = makeMockClient({ currentPeriod: 1n });
    const plan = makePlan(3);
    await expect(
      executePayday(plan, "0xpayroll", signer, client, { resumeFrom: 0, expectedPeriod: 1n }),
    ).rejects.toBeInstanceOf(PeriodGateError);
    expect(calls.filter((c) => c.startsWith("exec"))).toEqual([]);
  });

  it("allows fresh run when chain is one period behind expected", async () => {
    const { client } = makeMockClient({ currentPeriod: 0n });
    const plan = makePlan(1);
    const res = await executePayday(plan, "0xpayroll", signer, client, {
      resumeFrom: 0,
      expectedPeriod: 1n,
      preflight: false,
    });
    expect(res.completed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify**

Run: `cd ts && npx vitest run test/payday/execute.test.ts -t "resume"` and `-t "double-pay"`
Expected: PASS (Task 2 wired `assertPeriodGate` + resumeFrom). If FAIL, ensure `executePayday` calls `assertPeriodGate(currentPeriod, resumeFrom, expectedPeriod)` AFTER reading the period and BEFORE the loop, and that the gate throws (does not catch).

- [ ] **Step 3: Commit**

```bash
git add ts/test/payday/execute.test.ts
git commit -m "test(ts): #8 Phase B resume + double-pay gate integration (TDD)"
```

---

### Task 5: Monkey / red-team + full type-check

**Files:**
- Test: `ts/test/payday/execute.test.ts` (add monkey block)
- (No `execute.ts` change expected unless a monkey case exposes a gap.)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Write the monkey tests**

```ts
import { ResumeRangeError } from "../../src/payday/execute-types.js";

describe("executePayday — monkey / red-team", () => {
  it("empty plan -> completed, no chunks, no submissions", async () => {
    const { client, calls } = makeMockClient();
    const res = await executePayday(makePlan(0), "0xpayroll", signer, client, { preflight: false });
    expect(res.completed).toBe(true);
    expect(res.receipts).toEqual([]);
    expect(res.nextResumeFrom).toBeNull();
    expect(calls.filter((c) => c.startsWith("exec"))).toEqual([]);
  });

  it("resumeFrom beyond plan length throws ResumeRangeError", async () => {
    const { client } = makeMockClient();
    await expect(
      executePayday(makePlan(2), "0xpayroll", signer, client, { resumeFrom: 3 }),
    ).rejects.toBeInstanceOf(ResumeRangeError);
  });

  it("negative resumeFrom throws ResumeRangeError", async () => {
    const { client } = makeMockClient();
    await expect(
      executePayday(makePlan(2), "0xpayroll", signer, client, { resumeFrom: -1 }),
    ).rejects.toBeInstanceOf(ResumeRangeError);
  });

  it("resumeFrom === plan length is a no-op completed run (nothing left to pay)", async () => {
    const { client, calls } = makeMockClient({ currentPeriod: 1n });
    const res = await executePayday(makePlan(2), "0xpayroll", signer, client, { resumeFrom: 2 });
    expect(res.completed).toBe(true);
    expect(res.receipts.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(calls.filter((c) => c.startsWith("exec"))).toEqual([]);
  });

  it("waitForConfirm throwing mid-run propagates (caller resumes); later chunks not sent", async () => {
    const { client, calls } = makeMockClient({ throwWaitAt: 0 });
    await expect(
      executePayday(makePlan(3), "0xpayroll", signer, client, { preflight: false }),
    ).rejects.toThrow("wait timeout");
    // WHY: chunk[1] must not be submitted when chunk[0]'s confirmation is unknown (equivocation/H2b).
    expect(calls).not.toContain("exec:1");
  });
});
```

- [ ] **Step 2: Run the full suite**

Run: `cd ts && npx vitest run`
Expected: PASS — all prior Phase A tests (34) + all new executor tests, 0 regressions.

- [ ] **Step 3: Type-check**

Run: `cd ts && npm run build`
Expected: tsc clean, no errors.

- [ ] **Step 4: Commit**

```bash
git add ts/test/payday/execute.test.ts
git commit -m "test(ts): #8 Phase B monkey/red-team (empty/oob resume/wait-throw) (TDD)"
```

---

## Out of scope (do NOT implement here)

- The prod `SuiGrpcClient` adapter for `PaydayClient` (real `client.core.*` wiring). It is a thin
  IO shim verified against a live node — belongs to an integration step, not this unit-tested plan.
  The H1b verification gate (does the SDK resolve clock 0x6 as immutable from ABI?) is checked there.
- Phase C gas measurement; sponsored-gas signer seam. (Spec "Deferred".)

## Self-review notes

- Spec coverage: §1 API (Task 1-2), §2 loop incl. `$kind`/setSender/JIT-resolve (Task 2), §3 gate+receipts (Task 1,4), §4 testing matrix — happy/H2/fail-stop/resume/double-pay/preflight/monkey all mapped (Tasks 2-5). Adapter mapping intentionally deferred (Out of scope).
- Type consistency: `executePayday` signature, `ExecResult.kind`, `ChunkReceipt.status` union, `PeriodGateError`/`ResumeRangeError` used identically across tasks.
- `failExecAt`/`throwWaitAt` mock semantics are exec/wait-call index (0-based), which equals chunkIndex for all resumeFrom=0 tests; the resume test does not fail a chunk, so no mismatch.
