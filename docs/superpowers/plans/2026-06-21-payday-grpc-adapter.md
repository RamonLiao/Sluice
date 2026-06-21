# Payday gRPC Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a production `PaydayClient` adapter over `@mysten/sui@1.45.2` `SuiGrpcClient` so `executePayday` can drive a real Sui testnet, deploy + set up the contracts, and run an end-to-end payday + Phase C gas measurement.

**Architecture:** `executePayday` (merged, unchanged) consumes the narrow `PaydayClient` port. We implement that port in a new `GrpcPaydayClient` over `client.core.*`, keeping the pure decode/map logic in exported helpers (unit-testable with an injected fake core client) and the IO in thin class methods. Deploy is a manual `sui client publish`; a setup script creates the shared objects and writes `ts/testnet.json`; e2e + gas-bench scripts drive the live chain.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), `@mysten/sui@1.45.2` (`SuiGrpcClient`, `Transaction`, `bcs`, `Ed25519Keypair`), vitest, Sui Move (testnet), pnpm.

## Global Constraints

- Pin `@mysten/sui@1.45.2`. Do NOT bump to v2. gRPC is built in.
- Transport = `SuiGrpcClient` + `client.core.*`. NO JSON-RPC / Quorum Driver.
- Status discriminator: `res.transaction.effects.status.success` (`ExecutionStatus = {success:true;error:null}|{success:false;error:string}`). The literal `"FailedTransaction"` is the PORT's sentinel string the adapter emits — it is NOT an SDK value.
- `effects.gasUsed` is `GasCostSummary` (4 `string` fields). Net gas = `BigInt(computationCost)+BigInt(storageCost)-BigInt(storageRebate)`.
- All `u64` decoded as `bigint`, never JS `number`.
- `executePayday` / `execute-types.ts` port shape is LOCKED except the one `gasUsed`-on-failure line in Task 3.
- e2e coin type `T = 0x2::sui::SUI`.
- Existing 51/51 vitest must stay green (0 regression). New unit tests are additive.
- Per project test rule: every TDD task ends with monkey/edge cases where applicable.

---

### Task 1: Pure adapter helpers (`grpc-helpers.ts`)

**Files:**
- Create: `ts/src/payday/grpc-helpers.ts`
- Test: `ts/src/payday/grpc-helpers.test.ts`

**Interfaces:**
- Consumes: `TransactionResponse`, `GasCostSummary`, `ExecutionStatus` shapes from `@mysten/sui` `experimental/types` (structural — we type minimally, see below).
- Produces:
  - `computeNetGas(g: GasLike): bigint`
  - `mapExecResult(res: TxResponseLike): ExecResult` (from `execute-types.ts`)
  - `mapDryRun(res: TxResponseLike): DryRunResult`
  - `decodeCurrentPeriod(bytes: Uint8Array): bigint`
  - `PAYROLL_BCS` (the `bcs` struct used by `decodeCurrentPeriod`)
  - Minimal structural types `GasLike`, `TxResponseLike` so tests inject plain objects.

- [ ] **Step 1: Write the failing test**

```typescript
// ts/src/payday/grpc-helpers.test.ts
import { describe, it, expect } from "vitest";
import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { computeNetGas, mapExecResult, mapDryRun, decodeCurrentPeriod, PAYROLL_BCS } from "./grpc-helpers.js";

const gas = (c: string, s: string, r: string) => ({
  computationCost: c, storageCost: s, storageRebate: r, nonRefundableStorageFee: "0",
});

describe("computeNetGas", () => {
  it("nets rebate out of computation + storage", () => {
    expect(computeNetGas(gas("1000", "500", "200"))).toBe(1300n);
  });
  it("handles full rebate", () => {
    expect(computeNetGas(gas("1000", "500", "1500"))).toBe(0n);
  });
});

describe("mapExecResult", () => {
  it("maps success", () => {
    const res = { transaction: { digest: "0xabc", effects: { status: { success: true, error: null }, gasUsed: gas("10", "0", "0") } } };
    expect(mapExecResult(res)).toEqual({ kind: "success", digest: "0xabc", error: null, gasUsed: 10n });
  });
  it("maps abort to the port sentinel 'FailedTransaction' with gas captured", () => {
    const res = { transaction: { digest: "0xdef", effects: { status: { success: false, error: "MoveAbort 11" }, gasUsed: gas("7", "0", "0") } } };
    expect(mapExecResult(res)).toEqual({ kind: "FailedTransaction", digest: "0xdef", error: "MoveAbort 11", gasUsed: 7n });
  });
});

describe("mapDryRun", () => {
  it("ok on success", () => {
    expect(mapDryRun({ transaction: { effects: { status: { success: true, error: null } } } })).toEqual({ ok: true, error: null });
  });
  it("not-ok surfaces the abort string", () => {
    expect(mapDryRun({ transaction: { effects: { status: { success: false, error: "EInsufficientFunding" } } } })).toEqual({ ok: false, error: "EInsufficientFunding" });
  });
});

describe("decodeCurrentPeriod", () => {
  it("decodes current_period as bigint from a full Payroll<T> struct (layout pin)", () => {
    const addr = normalizeSuiAddress("0x1");
    const bytes = PAYROLL_BCS.serialize({
      id: addr, version: "1", owner_cap_id: addr, escrow_id: addr,
      funding: "0", employees: { id: addr, size: "0" }, current_period: "42",
    }).toBytes();
    expect(decodeCurrentPeriod(bytes)).toBe(42n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/payday/grpc-helpers.test.ts`
Expected: FAIL — `Cannot find module './grpc-helpers.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// ts/src/payday/grpc-helpers.ts
import { bcs } from "@mysten/sui/bcs";
import type { DryRunResult, ExecResult } from "./execute-types.js";

export interface GasLike {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}
type StatusLike = { success: true; error: null } | { success: false; error: string };
export interface TxResponseLike {
  transaction: { digest?: string; effects: { status: StatusLike; gasUsed?: GasLike } };
}

/** Net audit cost. effects.gasUsed is four BCS-string fields, not a scalar (1.45.2). */
export function computeNetGas(g: GasLike): bigint {
  return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
}

/** Map a core execute response to the port's ExecResult. 'FailedTransaction' is OUR sentinel,
 *  emitted when effects.status.success === false — NOT an SDK field (1.45.2 has no res.kind). */
export function mapExecResult(res: TxResponseLike): ExecResult {
  const { digest, effects } = res.transaction;
  const gasUsed = effects.gasUsed ? computeNetGas(effects.gasUsed) : null;
  if (effects.status.success) {
    return { kind: "success", digest: digest ?? "", error: null, gasUsed };
  }
  return { kind: "FailedTransaction", digest: digest ?? "", error: effects.status.error, gasUsed };
}

export function mapDryRun(res: TxResponseLike): DryRunResult {
  const { status } = res.transaction.effects;
  return status.success ? { ok: true, error: null } : { ok: false, error: status.error };
}

/** Payroll<T> BCS layout, field order mirrors payroll.move:65-82. Balance<T> = u64, Table = {id,size}. */
export const PAYROLL_BCS = bcs.struct("Payroll", {
  id: bcs.Address,
  version: bcs.u64(),
  owner_cap_id: bcs.Address,
  escrow_id: bcs.Address,
  funding: bcs.u64(),
  employees: bcs.struct("Table", { id: bcs.Address, size: bcs.u64() }),
  current_period: bcs.u64(),
});

export function decodeCurrentPeriod(bytes: Uint8Array): bigint {
  return BigInt(PAYROLL_BCS.parse(bytes).current_period);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/payday/grpc-helpers.test.ts && npx tsc --noEmit`
Expected: PASS (all cases) + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add ts/src/payday/grpc-helpers.ts ts/src/payday/grpc-helpers.test.ts
git commit -m "feat(ts): #8 pure gRPC adapter helpers (status/gas/period decode)"
```

---

### Task 2: `GrpcPaydayClient` class + factory (`grpc-client.ts`)

**Files:**
- Create: `ts/src/payday/grpc-client.ts`
- Test: `ts/src/payday/grpc-client.test.ts`

**Interfaces:**
- Consumes: `PaydayClient`, `PaydaySigner`, `DryRunResult`, `ExecResult` (`execute-types.ts`); helpers from Task 1; `Transaction` (`@mysten/sui/transactions`).
- Produces:
  - `class GrpcPaydayClient implements PaydayClient`
  - `interface CoreLike` — the minimal `client.core` surface the adapter uses (for injection/testing): `getObject`, `dryRunTransaction`, `executeTransaction`, `waitForTransaction`.
  - `interface SignerLike extends PaydaySigner` — adds `signTransaction(bytes: Uint8Array): Promise<{ signature: string }>`.
  - `makeGrpcPaydayClient(opts: { network: "testnet" | "mainnet" | "devnet" | "localnet" }): GrpcPaydayClient`
  - `assertClockImmutable(tx: Transaction): void` — H1 offline assertion helper (exported for the e2e/unit layer).

**Key facts (verified against installed 1.45.2 `.d.ts`):**
- `core.getObject({ objectId })` → `{ object: { content: PromiseLike<Uint8Array>, ... } }`.
- `core.dryRunTransaction({ transaction: Uint8Array })` → `{ transaction: TxResponse }`.
- `core.executeTransaction({ transaction: Uint8Array, signatures: string[] })` → `{ transaction: TxResponse }`.
- `core.waitForTransaction({ digest, timeout?, signal? })` → resolves on finality (existence), NOT on success; throws on timeout/not-found.
- `tx.build({ client })` runs `resolveTransactionPlugin` → resolves `tx.object()` refs, deriving `&Clock` as `mutable:false` from the ABI.
- Signing: `await tx.build({ client })` → `Uint8Array`; `await signer.signTransaction(bytes)` → `{ signature }`.

- [ ] **Step 1: Write the failing test**

```typescript
// ts/src/payday/grpc-client.test.ts
import { describe, it, expect, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { GrpcPaydayClient, type CoreLike, type SignerLike } from "./grpc-client.js";
import { PAYROLL_BCS } from "./grpc-helpers.js";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const addr = normalizeSuiAddress("0x1");
const periodBytes = (p: string) =>
  PAYROLL_BCS.serialize({ id: addr, version: "1", owner_cap_id: addr, escrow_id: addr, funding: "0", employees: { id: addr, size: "0" }, current_period: p }).toBytes();

function fakeCore(over: Partial<CoreLike> = {}): CoreLike {
  return {
    getObject: vi.fn(async () => ({ object: { content: Promise.resolve(periodBytes("7")) } })),
    dryRunTransaction: vi.fn(async () => ({ transaction: { effects: { status: { success: true, error: null } } } })),
    executeTransaction: vi.fn(async () => ({ transaction: { digest: "0xok", effects: { status: { success: true, error: null }, gasUsed: { computationCost: "5", storageCost: "0", storageRebate: "0" } } } })),
    waitForTransaction: vi.fn(async () => ({})),
    ...over,
  };
}
const signer: SignerLike = { toSuiAddress: () => addr, signTransaction: vi.fn(async () => ({ signature: "sig" })) };

// build() is stubbed so tests need no chain.
function stubBuild(tx: Transaction) { vi.spyOn(tx, "build").mockResolvedValue(new Uint8Array([1, 2, 3])); return tx; }

describe("GrpcPaydayClient", () => {
  it("getCurrentPeriod decodes the on-chain struct to bigint", async () => {
    const c = new GrpcPaydayClient(fakeCore());
    expect(await c.getCurrentPeriod("0xpayroll")).toBe(7n);
  });

  it("signAndExecute builds, signs, executes, returns mapped success result", async () => {
    const core = fakeCore();
    const c = new GrpcPaydayClient(core);
    const res = await c.signAndExecute(stubBuild(new Transaction()), signer);
    expect(res).toEqual({ kind: "success", digest: "0xok", error: null, gasUsed: 5n });
    expect(core.executeTransaction).toHaveBeenCalledWith({ transaction: new Uint8Array([1, 2, 3]), signatures: ["sig"] });
  });

  it("signAndExecute maps a Move abort to the FailedTransaction sentinel", async () => {
    const core = fakeCore({
      executeTransaction: vi.fn(async () => ({ transaction: { digest: "0xbad", effects: { status: { success: false, error: "MoveAbort 12" }, gasUsed: { computationCost: "3", storageCost: "0", storageRebate: "0" } } } })),
    });
    const res = await new GrpcPaydayClient(core).signAndExecute(stubBuild(new Transaction()), signer);
    expect(res.kind).toBe("FailedTransaction");
    expect(res.error).toBe("MoveAbort 12");
    expect(res.gasUsed).toBe(3n);
  });

  it("dryRunTransaction surfaces abort as ok:false", async () => {
    const core = fakeCore({ dryRunTransaction: vi.fn(async () => ({ transaction: { effects: { status: { success: false, error: "EInsufficientFunding" } } } })) });
    expect(await new GrpcPaydayClient(core).dryRunTransaction(stubBuild(new Transaction()))).toEqual({ ok: false, error: "EInsufficientFunding" });
  });

  it("waitForConfirm resolves for a finalized-with-abort digest (does not inspect status)", async () => {
    const core = fakeCore({ waitForTransaction: vi.fn(async () => ({ transaction: { effects: { status: { success: false, error: "x" } } } })) });
    await expect(new GrpcPaydayClient(core).waitForConfirm("0xany")).resolves.toBeUndefined();
  });

  it("waitForConfirm rethrows a timeout loudly", async () => {
    const core = fakeCore({ waitForTransaction: vi.fn(async () => { throw new Error("timeout"); }) });
    await expect(new GrpcPaydayClient(core).waitForConfirm("0xnever")).rejects.toThrow("timeout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/payday/grpc-client.test.ts`
Expected: FAIL — `Cannot find module './grpc-client.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// ts/src/payday/grpc-client.ts
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { PaydayClient, PaydaySigner, DryRunResult, ExecResult } from "./execute-types.js";
import { mapExecResult, mapDryRun, decodeCurrentPeriod, type TxResponseLike } from "./grpc-helpers.js";

/** Minimal client.core surface the adapter uses; the real SuiGrpcClient.core satisfies it. */
export interface CoreLike {
  getObject(o: { objectId: string }): Promise<{ object: { content: PromiseLike<Uint8Array> } }>;
  dryRunTransaction(o: { transaction: Uint8Array }): Promise<TxResponseLike>;
  executeTransaction(o: { transaction: Uint8Array; signatures: string[] }): Promise<TxResponseLike>;
  waitForTransaction(o: { digest: string; timeout?: number }): Promise<unknown>;
}

/** The port's signer only needs toSuiAddress(); the adapter also needs real signing. A
 *  @mysten/sui Keypair (e.g. Ed25519Keypair) satisfies this. */
export interface SignerLike extends PaydaySigner {
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
}

const WAIT_TIMEOUT_MS = 60_000;

export class GrpcPaydayClient implements PaydayClient {
  constructor(private readonly core: CoreLike) {}

  async getCurrentPeriod(payrollId: string): Promise<bigint> {
    const { object } = await this.core.getObject({ objectId: payrollId });
    return decodeCurrentPeriod(await object.content);
  }

  async dryRunTransaction(tx: Transaction): Promise<DryRunResult> {
    const bytes = await tx.build({ client: this.core as unknown as Parameters<Transaction["build"]>[0]["client"] });
    return mapDryRun(await this.core.dryRunTransaction({ transaction: bytes }));
  }

  async signAndExecute(tx: Transaction, signer: PaydaySigner): Promise<ExecResult> {
    const s = signer as SignerLike;
    const bytes = await tx.build({ client: this.core as unknown as Parameters<Transaction["build"]>[0]["client"] });
    const { signature } = await s.signTransaction(bytes);
    return mapExecResult(await this.core.executeTransaction({ transaction: bytes, signatures: [signature] }));
  }

  async waitForConfirm(digest: string): Promise<void> {
    // Resolves on finality (existence), not success — safe for a finalized-with-abort tx.
    // Throws loudly only on timeout / not-found; do not swallow.
    await this.core.waitForTransaction({ digest, timeout: WAIT_TIMEOUT_MS });
  }
}

export function makeGrpcPaydayClient(opts: {
  network: "testnet" | "mainnet" | "devnet" | "localnet";
}): GrpcPaydayClient {
  const client = new SuiGrpcClient({ network: opts.network });
  return new GrpcPaydayClient(client.core as unknown as CoreLike);
}

/** H1 offline assertion: after build, the clock 0x6 shared input must be mutable:false. */
export function assertClockImmutable(builtInputs: ReadonlyArray<{ Object?: { SharedObject?: { objectId: string; mutable: boolean } } }>): void {
  const clock = builtInputs.find((i) => i.Object?.SharedObject?.objectId === "0x0000000000000000000000000000000000000000000000000000000000000006");
  if (!clock) throw new Error("H1: clock 0x6 not found among shared inputs");
  if (clock.Object!.SharedObject!.mutable !== false) {
    throw new Error("H1 FAIL: clock 0x6 resolved mutable:true — expected immutable (&Clock)");
  }
}
```

Note: the `as unknown as` casts bridge the structural `CoreLike` to the SDK's nominal `ClientWithCoreApi` that `tx.build` expects; the real `SuiGrpcClient` satisfies both. If `tsc` rejects the cast, type `core` as `SuiGrpcClient["core"]` in the constructor and keep `CoreLike` only for tests via a generic `<C extends CoreLike>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/payday/grpc-client.test.ts && npx tsc --noEmit`
Expected: PASS (6 cases) + tsc clean.

- [ ] **Step 5: Run the full suite (0 regression)**

Run: `cd ts && npx vitest run`
Expected: PASS — 51 existing + Task 1 + Task 2 new, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add ts/src/payday/grpc-client.ts ts/src/payday/grpc-client.test.ts
git commit -m "feat(ts): #8 GrpcPaydayClient adapter over SuiGrpcClient core"
```

---

### Task 3: Executor patch — capture `gasUsed` on failure receipt

**Files:**
- Modify: `ts/src/payday/execute.ts:87-90` (the `FailedTransaction` branch)
- Test: `ts/src/payday/execute.test.ts` (existing executor test file — add one case)

**Interfaces:**
- Consumes: existing `ExecResult.gasUsed` (already populated by Task 1/2 on both branches).
- Produces: failure `ChunkReceipt.gasUsed` now non-null when the chain reported gas.

**Why:** Phase B left `gasUsed` uncaptured on failed receipts (leftover [2]). The adapter now provides it on both branches; the executor's failure branch must copy it for audit.

- [ ] **Step 1: Write the failing test**

Find the existing executor test file and add (adjust the mock-client helper name to match the file's existing pattern):

```typescript
// add to ts/src/payday/execute.test.ts
it("captures gasUsed on a failed chunk receipt", async () => {
  // a client whose signAndExecute returns a FailedTransaction with gasUsed
  const client = makeMockClient({
    getCurrentPeriod: async () => 0n,
    dryRunTransaction: async () => ({ ok: true, error: null }),
    signAndExecute: async () => ({ kind: "FailedTransaction", digest: "0xf", error: "MoveAbort 3", gasUsed: 99n }),
    waitForConfirm: async () => {},
  });
  const plan = makeSingleChunkPlan(); // 1 transaction, 1 chunk — reuse the file's existing builder
  const out = await executePayday(plan, "0xpayroll", mockSigner, client, { preflight: true });
  expect(out.completed).toBe(false);
  expect(out.receipts[0]!.status).toBe("failure");
  expect(out.receipts[0]!.gasUsed).toBe(99n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/payday/execute.test.ts -t "captures gasUsed on a failed"`
Expected: FAIL — `expected null to be 99n` (current failure branch omits gasUsed).

- [ ] **Step 3: Write minimal implementation**

In `ts/src/payday/execute.ts`, change the `FailedTransaction` branch:

```typescript
    if (res.kind === "FailedTransaction") {
      receipts[i] = { ...receipts[i]!, digest: res.digest, status: "failure", error: res.error, gasUsed: res.gasUsed };
      return { receipts, completed: false, nextResumeFrom: i }; // fail-stop
    }
```

(Only `gasUsed: res.gasUsed` is added.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/payday/execute.test.ts && npx tsc --noEmit`
Expected: PASS + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add ts/src/payday/execute.ts ts/src/payday/execute.test.ts
git commit -m "fix(ts): #8 capture gasUsed on failed payday chunk receipt (leftover [2])"
```

---

### Task 4: Testnet deploy + setup script (`testnet-setup.ts`)

**Files:**
- Create: `ts/scripts/testnet-setup.ts`
- Create (generated): `ts/testnet.json`
- Modify: `ts/.gitignore` (add `testnet.json`) — create the file if absent
- Modify: `move-notes.md` (record packageId + UpgradeCap)

**Interfaces:**
- Consumes: `SuiGrpcClient`, `Transaction`, `Ed25519Keypair`, `bcs`.
- Produces: `ts/testnet.json` = `{ network, packageId, coinType, payrollId, ownerCapId, escrowId, scallopId, naviId, scallopAdminCapId, naviAdminCapId, employees: string[] }`.

**Prerequisite (manual, do first):**

```bash
cd move && sui move build
sui client publish --gas-budget 500000000
# Record from output: packageId (the published package) + UpgradeCap object id.
```

Write `packageId` into a starter `ts/testnet.json` (and the UpgradeCap into `move-notes.md`). The script does NOT publish.

**Signer:** the script reads the active CLI keypair from `~/.sui/sui_config/sui.keystore` (first key) or an env var `SUI_PRIVATE_KEY` (bech32 `suiprivkey...`). Use `Ed25519Keypair.fromSecretKey(...)`. Document which one in the script header.

- [ ] **Step 1: Write the setup script**

```typescript
// ts/scripts/testnet-setup.ts
// One-shot testnet setup. Run AFTER `sui client publish` and writing packageId into ts/testnet.json.
// Usage: cd ts && SUI_PRIVATE_KEY=suiprivkey... npx tsx scripts/testnet-setup.ts
import { readFileSync, writeFileSync } from "node:fs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const SUI = "0x2::sui::SUI";
const CFG = "./testnet.json";
const cfg = JSON.parse(readFileSync(CFG, "utf8"));
if (!cfg.packageId) throw new Error("set packageId in testnet.json (from sui client publish) first");

const kp = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
const me = kp.toSuiAddress();
const client = new SuiGrpcClient({ network: "testnet" });
const core = client.core;

// Helper: build → sign → execute → wait → return effects.changedObjects (created) with types.
async function run(tx: Transaction) {
  tx.setSender(me);
  const bytes = await tx.build({ client });
  const { signature } = await kp.signTransaction(bytes);
  const { transaction } = await core.executeTransaction({ transaction: bytes, signatures: [signature] });
  if (!transaction.effects.status.success) throw new Error(`tx failed: ${transaction.effects.status.error}`);
  await core.waitForTransaction({ digest: transaction.digest });
  const created = transaction.effects.changedObjects.filter((c: any) => c.idOperation === "Created");
  const ids = created.map((c: any) => c.objectId ?? c.id);
  const { objects } = await core.getObjects({ objectIds: ids });
  return objects.map((o: any, i: number) => ({ id: ids[i], type: o.type as string, owner: created[i].outputOwner }));
}

const pkg = cfg.packageId;
const typeOf = (suffix: string) => `${pkg}::${suffix}`;

// 1. create_payroll<SUI> → Payroll<SUI> (shared), TaxEscrow<SUI> (shared), PayrollOwnerCap (owned)
{
  const tx = new Transaction();
  tx.moveCall({ target: `${pkg}::payroll::create_payroll`, typeArguments: [SUI], arguments: [] });
  const objs = await run(tx);
  cfg.payrollId = objs.find((o) => o.type.startsWith(typeOf("payroll::Payroll")))!.id;
  cfg.escrowId = objs.find((o) => o.type.startsWith(typeOf("escrow::TaxEscrow")))!.id;
  cfg.ownerCapId = objs.find((o) => o.type.startsWith(typeOf("payroll::PayrollOwnerCap")))!.id;
}

// 2. mock_scallop::create<SUI>(rate_per_sec, clock) → MockScallopVault<SUI> (shared) + AdminCap
{
  const tx = new Transaction();
  tx.moveCall({ target: `${pkg}::mock_scallop::create`, typeArguments: [SUI], arguments: [tx.pure.u128(0n), tx.object("0x6")] });
  const objs = await run(tx);
  cfg.scallopId = objs.find((o) => o.type.startsWith(typeOf("mock_scallop::MockScallopVault")))!.id;
  cfg.scallopAdminCapId = objs.find((o) => o.type.startsWith(typeOf("mock_scallop::AdminCap")))!.id;
}

// 3. mock_navi::create<SUI>(index_price) → MockNaviVault<SUI> (shared) + AdminCap
{
  const tx = new Transaction();
  tx.moveCall({ target: `${pkg}::mock_navi::create`, typeArguments: [SUI], arguments: [tx.pure.u64(1n)] });
  const objs = await run(tx);
  cfg.naviId = objs.find((o) => o.type.startsWith(typeOf("mock_navi::MockNaviVault")))!.id;
  cfg.naviAdminCapId = objs.find((o) => o.type.startsWith(typeOf("mock_navi::AdminCap")))!.id;
}

// 4. fund<SUI>: split a distinct funding coin from gas (S7 anti-equivocation). tx.gas is the gas
//    coin; splitting from it yields a NEW coin object used only as the Move-call input — not gas.
{
  const tx = new Transaction();
  const [funding] = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000n)]); // 0.1 SUI into the pool
  tx.moveCall({ target: `${pkg}::payroll::fund`, typeArguments: [SUI], arguments: [tx.object(cfg.payrollId), tx.object(cfg.ownerCapId), funding] });
  await run(tx);
}

// 5. add_employee<SUI> × 3 (distinct fresh addresses). gross 1_000_000 MIST, 10% withholding.
const employees = [Ed25519Keypair.generate(), Ed25519Keypair.generate(), Ed25519Keypair.generate()].map((k) => k.toSuiAddress());
for (const emp of employees) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::payroll::add_employee`, typeArguments: [SUI],
    arguments: [tx.object(cfg.payrollId), tx.object(cfg.ownerCapId), tx.pure.address(emp), tx.pure.vector("u8", [...new TextEncoder().encode("US")]), tx.pure.u64(1_000_000n), tx.pure.u16(1000)],
  });
  await run(tx);
}
cfg.employees = employees;
cfg.coinType = SUI;
cfg.network = "testnet";

writeFileSync(CFG, JSON.stringify(cfg, null, 2));
console.log("testnet.json written:", cfg);
```

- [ ] **Step 2: Add tsx + gitignore**

```bash
cd ts && pnpm add -D tsx
printf "node_modules\ntestnet.json\n" >> .gitignore  # create .gitignore if missing
```

- [ ] **Step 3: Run deploy + setup**

```bash
cd ../move && sui move build && sui client publish --gas-budget 500000000
# write packageId into ts/testnet.json: {"packageId":"0x..."}
cd ../ts && SUI_PRIVATE_KEY=$(sui keytool export --key-identity $(sui client active-address) --json 2>/dev/null | jq -r .exportedPrivateKey) npx tsx scripts/testnet-setup.ts
```

Expected: `testnet.json written:` with all of `payrollId, escrowId, ownerCapId, scallopId, naviId, employees[3]` populated, non-null. If any `.find(...)!` throws "cannot read .id of undefined", the type-prefix match is wrong — print `objs` and fix the suffix.

- [ ] **Step 4: Commit (script + gitignore + notes only; NOT testnet.json)**

```bash
git add ts/scripts/testnet-setup.ts ts/.gitignore ts/package.json move-notes.md
git commit -m "feat(ts): #8 testnet deploy setup script + record packageId"
```

---

### Task 5: End-to-end payday (`e2e-payday.ts`)

**Files:**
- Create: `ts/scripts/e2e-payday.ts`

**Interfaces:**
- Consumes: `buildPayday`, `executePayday`, `makeGrpcPaydayClient`, `assertClockImmutable`, `getFxScalars` (existing fx module), `Ed25519Keypair`, `testnet.json`.
- Produces: console assertions; exit non-zero on any failure.

- [ ] **Step 1: Write the e2e script**

```typescript
// ts/scripts/e2e-payday.ts
// Live testnet e2e. Usage: cd ts && SUI_PRIVATE_KEY=... npx tsx scripts/e2e-payday.ts
import { readFileSync } from "node:fs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { buildPayday } from "../src/payday/build.js";
import { executePayday } from "../src/payday/execute.js";
import { makeGrpcPaydayClient, assertClockImmutable } from "../src/payday/grpc-client.js";
import { getFxScalars } from "../src/fx/index.js"; // adjust to the fx module's actual export path
import type { PaydayConfig, PaydayEmployee } from "../src/payday/types.js";

const cfg = JSON.parse(readFileSync("./testnet.json", "utf8"));
const kp = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
const client = makeGrpcPaydayClient({ network: "testnet" });

const config: PaydayConfig = {
  packageId: cfg.packageId, coinType: cfg.coinType, payrollId: cfg.payrollId,
  ownerCapId: cfg.ownerCapId, escrowId: cfg.escrowId, scallopId: cfg.scallopId,
  naviId: cfg.naviId, clockId: "0x6",
};

const pair = "EUR/USD" as const;
const employees: PaydayEmployee[] = cfg.employees.map((addr: string) => ({ addr, pair }));
const fx = await getFxScalars(pair);
const fxByPair = new Map([[pair, fx]]);

// H1 offline assertion on the built first chunk before any send.
const plan = buildPayday(employees, fxByPair, config);
const built = await plan.transactions[0]!.build({ client: new SuiGrpcClient({ network: "testnet" }) as any });
// inspect serialized inputs — exact accessor depends on the build output shape; log + assert:
// assertClockImmutable(<shared inputs from built tx data>);  // wire to actual input array

const before = await client.getCurrentPeriod(cfg.payrollId);
const result = await executePayday(plan, cfg.payrollId, kp, client, { expectedPeriod: before + 1n });

if (!result.completed) throw new Error(`payday incomplete: ${JSON.stringify(result.receipts)}`);
const after = await client.getCurrentPeriod(cfg.payrollId);
if (after !== before + 1n) throw new Error(`period did not advance by 1: ${before} -> ${after}`);
for (const r of result.receipts) if (r.status !== "success") throw new Error(`chunk ${r.chunkIndex} not success`);
console.log("E2E OK:", { before, after, receipts: result.receipts.map((r) => ({ i: r.chunkIndex, digest: r.digest, gas: r.gasUsed?.toString() })) });

// Resume safety: re-running the SAME plan must be blocked by the period gate (no double begin_period).
try {
  await executePayday(plan, cfg.payrollId, kp, client, { expectedPeriod: before + 1n });
  throw new Error("RESUME FAIL: second full run should have been gated");
} catch (e: any) {
  if (!/PeriodGate|already|double/i.test(e.message)) throw e;
  console.log("RESUME GATE OK:", e.message);
}
```

- [ ] **Step 2: Run e2e**

```bash
cd ts && SUI_PRIVATE_KEY=$(sui keytool export --key-identity $(sui client active-address) --json | jq -r .exportedPrivateKey) npx tsx scripts/e2e-payday.ts
```

Expected: `E2E OK:` with `after === before + 1`, all receipts success, then `RESUME GATE OK:`. If `assertClockImmutable` (once wired) throws, H1 failed → apply the §11 builder fallback and re-run Phase A tests.

- [ ] **Step 3: Wire the H1 assertion**

Inspect the logged built-tx input shape, then replace the commented `assertClockImmutable(...)` with the real shared-input array accessor so a mutable clock fails the run loudly. Re-run Step 2.

- [ ] **Step 4: Commit**

```bash
git add ts/scripts/e2e-payday.ts
git commit -m "feat(ts): #8 live testnet e2e payday + resume gate + H1 clock assertion"
```

---

### Task 6: Phase C gas benchmark (`gas-bench.ts`)

**Files:**
- Create: `ts/scripts/gas-bench.ts`

**Interfaces:**
- Consumes: same as Task 5 + `add_employee` flow from Task 4's helper (or reuse `testnet-setup` patterns).
- Produces: a printed gas-per-chunk table at N = 3 / 50 / 100; a recommendation on `MAX_BATCH`.

- [ ] **Step 1: Write the benchmark script**

```typescript
// ts/scripts/gas-bench.ts
// Phase C: measure payday gas at N=3/50/100. Usage: cd ts && SUI_PRIVATE_KEY=... npx tsx scripts/gas-bench.ts
// Adds N fresh employees to the existing payroll, runs one payday, records gasUsed per chunk.
import { readFileSync } from "node:fs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { buildPayday } from "../src/payday/build.js";
import { executePayday } from "../src/payday/execute.js";
import { makeGrpcPaydayClient } from "../src/payday/grpc-client.js";
import { getFxScalars } from "../src/fx/index.js";
import type { PaydayConfig, PaydayEmployee } from "../src/payday/types.js";

const cfg = JSON.parse(readFileSync("./testnet.json", "utf8"));
const kp = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
const me = kp.toSuiAddress();
const client = makeGrpcPaydayClient({ network: "testnet" });
const grpc = new SuiGrpcClient({ network: "testnet" });
const SUI = cfg.coinType;
const pair = "EUR/USD" as const;
const fxByPair = new Map([[pair, await getFxScalars(pair)]]);

async function send(tx: Transaction) {
  tx.setSender(me);
  const bytes = await tx.build({ client: grpc });
  const { signature } = await kp.signTransaction(bytes);
  const { transaction } = await grpc.core.executeTransaction({ transaction: bytes, signatures: [signature] });
  if (!transaction.effects.status.success) throw new Error(transaction.effects.status.error!);
  await grpc.core.waitForTransaction({ digest: transaction.digest });
}

async function addEmployees(n: number): Promise<string[]> {
  const addrs: string[] = [];
  for (let i = 0; i < n; i++) {
    const emp = Ed25519Keypair.generate().toSuiAddress();
    const tx = new Transaction();
    tx.moveCall({ target: `${cfg.packageId}::payroll::add_employee`, typeArguments: [SUI],
      arguments: [tx.object(cfg.payrollId), tx.object(cfg.ownerCapId), tx.pure.address(emp), tx.pure.vector("u8", [...new TextEncoder().encode("US")]), tx.pure.u64(1000n), tx.pure.u16(1000)] });
    await send(tx);
    addrs.push(emp);
  }
  return addrs;
}

const config: PaydayConfig = { packageId: cfg.packageId, coinType: SUI, payrollId: cfg.payrollId, ownerCapId: cfg.ownerCapId, escrowId: cfg.escrowId, scallopId: cfg.scallopId, naviId: cfg.naviId, clockId: "0x6" };

for (const N of [3, 50, 100]) {
  const addrs = await addEmployees(N);
  const employees: PaydayEmployee[] = addrs.map((addr) => ({ addr, pair }));
  const plan = buildPayday(employees, fxByPair, config);
  const before = await client.getCurrentPeriod(cfg.payrollId);
  const res = await executePayday(plan, cfg.payrollId, kp, client, { expectedPeriod: before + 1n });
  const perChunk = res.receipts.map((r) => ({ chunk: r.chunkIndex, n: r.employees.length, gas: r.gasUsed?.toString() ?? "n/a", status: r.status }));
  console.log(`N=${N}: chunks=${plan.transactions.length}`, perChunk);
}
console.log("Phase C done. If a single 50-employee chunk's gas is near the per-tx ceiling, lower MAX_BATCH; else 50 holds.");
```

Note: funding must cover 3+50+100 payments (each gross 1000 MIST here → ~153k MIST total, trivially under the 0.1 SUI funded in Task 4). If `EInsufficientFunding` fires, re-`fund` first.

- [ ] **Step 2: Run the benchmark**

```bash
cd ts && SUI_PRIVATE_KEY=$(sui keytool export --key-identity $(sui client active-address) --json | jq -r .exportedPrivateKey) npx tsx scripts/gas-bench.ts
```

Expected: three `N=...` lines with gas per chunk. Record the numbers.

- [ ] **Step 3: Record findings + commit**

Update `move-notes.md` and `tasks/progress.md` with the gas table and the `MAX_BATCH` verdict.

```bash
git add ts/scripts/gas-bench.ts move-notes.md tasks/progress.md
git commit -m "feat(ts): #8 Phase C gas benchmark + MAX_BATCH calibration"
```

---

## Post-implementation

- Run `cd ts && npx vitest run && npx tsc --noEmit` — full suite green, 0 regression.
- Run the mandatory two-round review (`/dual-review`): round 1 codex generic on the TS adapter; round 2 project rules (the adapter is non-Move TS, so generic reviewer is allowed per skill-routing — but the Move setup calls touch contract semantics, so sanity-check object/cap usage against `payroll.move`).
- Update `tasks/progress.md`: #8 Phase B+C + prod adapter done; remaining = #9 frontend.

## Self-Review

**Spec coverage:**
- §2 transport correction → Task 1/2 (status mapping sentinel, gas formula) ✓
- §4 four port methods → Task 2 (all four) ✓
- §4.2 gasUsed-on-failure → Task 1 (helper) + Task 3 (executor) ✓
- §4 getCurrentPeriod BCS decode (I3 update) → Task 1 (`decodeCurrentPeriod`, `PAYROLL_BCS`) ✓
- §5 setup + id extraction (I5 two-step) → Task 4 (`run()` helper: changedObjects→getObjects→type) ✓
- §5 S7 gas equivocation → Task 4 step 1 (`splitCoins(tx.gas)`) ✓
- §6 manual publish → Task 4 prerequisite ✓
- §7 e2e + resume → Task 5 ✓
- §7.7 H1 offline assertion (S6) → Task 2 (`assertClockImmutable`) + Task 5 (wire it) ✓
- §8 Phase C gas → Task 6 ✓
- §10 unit/integration/monkey → Tasks 1-2 unit, 5 integration; monkey: resume-gate (Task 5), EInsufficientFunding noted (Task 6). Add an empty-funding monkey case if time permits in Task 5.
- §11 H1 fallback → referenced in Task 5 step 2 ✓

**Placeholder scan:** the only deferred wiring is `assertClockImmutable`'s exact input-array accessor (Task 5 step 3) — intentional, because the built-tx serialized input shape is best read from a live log rather than guessed; the assertion fn itself is complete. Flagged explicitly, not a silent TODO.

**Type consistency:** `mapExecResult`/`mapDryRun`/`decodeCurrentPeriod`/`PAYROLL_BCS` names consistent Task 1↔2. `CoreLike`/`SignerLike` defined Task 2, used Task 2. `ExecResult.kind` sentinel `"FailedTransaction"` consistent with locked `execute.ts:87`.
