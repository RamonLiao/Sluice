# PayrollFlow #8 — prod gRPC adapter + testnet e2e + Phase C gas

_Date: 2026-06-21 · Status: design (pending user approval)_

## 1. Goal

Close the two remaining #8 leftovers from Phase B (merge `0d0b10f`):

1. **prod gRPC adapter** — a real implementation of the `PaydayClient` port (`ts/src/payday/execute-types.ts:21`) over `@mysten/sui`'s `SuiGrpcClient`, so `executePayday` can drive a real chain instead of a mock.
2. **H1/H1b clock(0x6) mutability verification** — confirm, against a real testnet build, that the SDK resolves the unresolved `Transaction` (builder returns `tx.object(id)` refs) with `clock 0x6` as an **immutable** shared object. Mock tests structurally cannot cover this.

Plus the deferred **Phase C gas measurement** (calibrate `MAX_BATCH=50`) and the **testnet deploy + setup** required to run any of it end-to-end.

Non-goals: mainnet, multi-employer, real USDC type, sponsored tx, real Scallop/Navi. All explicitly out of scope (GTM blockers, tracked in progress.md).

## 2. Key decisions

- **`T = 0x2::sui::SUI`** for the testnet e2e. No mock-USDC module exists; funding comes straight from the test account's SUI. The contracts are `Payroll<phantom T>` / `TaxEscrow<T>` / vaults `<T>` — swapping to production USDC at GTM is a single type-arg change, zero contract edits. This is the payoff of the generic design (mirrors the #2/#5 deviation rationale).
- **Transport = `SuiGrpcClient` + `client.core.*`** (`GrpcCoreClient extends Experimental_CoreClient`). JSON-RPC / Quorum Driver are deprecated.
- **⚠ Rule-7 correction (supersedes Phase B "定案")**: Phase B recorded status discrimination as `res.kind === 'FailedTransaction'`. **That field does not exist in the pinned `@mysten/sui@1.45.2` `client.core.*` surface** (verified: `grep FailedTransaction node_modules/@mysten/sui/dist/esm` → empty; that shape is a v2 / proto-layer artifact). The real status is `res.transaction.effects.status`, typed `ExecutionStatus = { success: true; error: null } | { success: false; error: string }` (`experimental/types.d.ts:421`). The adapter maps `effects.status.success === false` → failure and reads the abort string from `effects.status.error`. **Port-sentinel kept**: the executor (locked, `execute.ts:87`) branches on `res.kind === "FailedTransaction"`, so the adapter *emits* the literal string `"FailedTransaction"` as the port's own sentinel when `success === false`. `"FailedTransaction"` is OUR port value, NOT an SDK value — document at the emit site. (Without this correction, `res.kind` is `undefined` → every tx treated as success → fail-stop never fires → double-pay break.)
- **`dryRunTransaction` takes a built `Uint8Array`, no signer** (`experimental/types.d.ts`). The adapter `await tx.build({ client })` then dry-runs; the executor having called `tx.setSender()` (`execute.ts:74`) is necessary but not sufficient — build is the adapter's job (build-then-dryrun, build-then-execute).
- **Pin `@mysten/sui@1.45.2`** (already has gRPC built in). Do **not** bump to v2.
- **The adapter is the only new IO surface.** `executePayday` is unchanged — it already holds the sequential / resume / fail-stop / double-pay-gate logic and consumes the port. We implement the port; we do not touch the orchestrator.

## 3. Architecture

```
buildPayday (pure)  ──►  PaydayPlan { transactions[], chunks[] }
                                 │
executePayday (orchestrator, unchanged)
                                 │  calls PaydayClient port
                                 ▼
        ┌──────────────── NEW ────────────────┐
        │ GrpcPaydayClient implements          │
        │   PaydayClient over SuiGrpcClient    │
        └──────────────────────────────────────┘
                                 │ client.core.*
                                 ▼
                         Sui testnet (gRPC)
```

New files:
- `ts/src/payday/grpc-client.ts` — `GrpcPaydayClient` implementing `PaydayClient`, plus a `makeGrpcPaydayClient(opts)` factory.
- `ts/src/payday/testnet-setup.ts` — one-shot script: publish-aware setup that creates payroll/escrow/vaults, funds, adds employees, and writes `ts/testnet.json`.
- `ts/testnet.json` — generated config: `{ packageId, payrollId, escrowId, ownerCapId, scallopId, naviId, employees[], coinType }`. Git-ignored (env-specific, regenerable).
- `ts/src/payday/grpc-client.test.ts` — unit tests for the pure decode/discriminate logic (port methods that don't need a live chain).
- `ts/scripts/e2e-payday.ts` — drives `executePayday` against testnet; asserts paid + period advance + resume safety.
- `ts/scripts/gas-bench.ts` — Phase C: 3 / 50 / 100 employees, records gasUsed per chunk.

## 4. `GrpcPaydayClient` — port method contracts

Implements `PaydayClient` (4 methods). Constructed with `{ client: SuiGrpcClient }`.

| Method | Implementation | Hard contract |
|--------|----------------|---------------|
| `getCurrentPeriod(payrollId)` | `getObject({objectId})` → `await object.content` (whole-struct BCS `Uint8Array`) → **BCS-decode** the `Payroll<T>` struct, read `current_period` → `bigint`. (I3 update: the architect's preferred dryRun-view path is **NOT available** — `DryRunTransactionResponse`/`TransactionEffects` carry no Move return values in 1.45.2, verified. So option (a) BCS decode is the only path.) Layout is deterministic: `id:Address, version:u64, owner_cap_id:Address, escrow_id:Address, funding:u64 (Balance<T>), employees:{id:Address,size:u64} (Table), current_period:u64`. | must read live state; used by the period gate (`execute.ts:67`). Decode `u64` as `bigint`, never JS `number`. Pin layout in a unit test + cross-check decoded value in e2e to catch field reordering. |
| `dryRunTransaction(tx)` | `await tx.build({ client })` → `client.core.dryRunTransaction({ transaction: bytes })`. Map `res.transaction.effects.status.success === false` → `{ ok:false, error: status.error }` | no signer passed; **must not** sign. Returns `ok:false` on any abort, surfaces the Move abort string. |
| `signAndExecute(tx, signer)` | `await tx.build({ client })` (resolves objects, incl. **H1 clock**), sign with `signer`, `client.core.executeTransaction`. Read `res.transaction.effects.status.success`; on `false` set `kind:"FailedTransaction"` (port sentinel, §2) + `error: status.error`. Capture `gasUsed` from `effects.gasUsed` on **both** branches. | **H1/H1b**: build-time resolution marks clock `0x6` immutable. `gasUsed` captured **even on failure** (closes leftover [2]); effects exist on aborts so same path. |
| `waitForConfirm(digest)` | `client.core.waitForTransaction({ digest, timeout, signal })` (`core.d.ts:31`) — polls `getTransaction` to **existence/finality**, does NOT inspect `effects.status`. | **leftover [3]**: called *before* the failure check (`execute.ts:85`). Resolves cleanly for a finalized-with-abort tx (it exists on-chain). **Throws loudly** only on timeout / not-found — set an explicit `timeout`, do NOT swallow. (Not "never throws"; it throws iff never finalized.) |

**`gasUsed` formula (C2)**: `effects.gasUsed` is `GasCostSummary = { computationCost, storageCost, storageRebate, nonRefundableStorageFee }`, all `string` (`types.d.ts:415`) — no scalar. Adapter computes **net** = `BigInt(computationCost) + BigInt(storageCost) - BigInt(storageRebate)` and reports that as `ExecResult.gasUsed`. Net (rebate-inclusive) is the true audit cost; document the formula at the call site.

### 4.1 Signer

`PaydaySigner` (`execute-types.ts:4`) only requires `toSuiAddress()`. The adapter's `signAndExecute` needs actual signing, so the concrete signer passed in must be a real `@mysten/sui` `Keypair` (e.g. `Ed25519Keypair`). The port stays narrow; the adapter does the structural type-widening at the call site (cast/assert the signer is a `Signer`). Document this coupling explicitly.

### 4.2 gasUsed on failure (leftover [2])

Phase B left `gasUsed` uncaptured on failed receipts. The adapter extracts gas cost summary from the execution result on **both** paths (success and `FailedTransaction`) so audit receipts always carry cost. The executor's failure branch (`execute.ts:88`) currently doesn't copy `gasUsed` — a one-line executor patch adds it. (Surgical, in-scope: it's the same leftover.)

## 5. Testnet setup flow (`testnet-setup.ts`)

Idempotent-ish one-shot. Reads `ts/testnet.json` if present (skip already-done steps), else:

1. Assert `packageId` present (publish is a manual `sui client publish` step recorded into the config — see §6; the script does not publish).
2. `create_payroll<SUI>()` → parse created objects for `Payroll<SUI>` (shared), `TaxEscrow<SUI>` (shared), `PayrollOwnerCap` (owned). Record ids.
3. `mock_scallop::create<SUI>(rate_per_sec, clock)` → shared vault id + AdminCap.
4. `mock_navi::create<SUI>(index_price)` → shared vault id + AdminCap.
5. `fund<SUI>(payroll, cap, coin)` — split a SUI coin (e.g. 1 SUI) into funding. **Gas-vs-funding equivocation (S7)**: gas and funding are both `Coin<SUI>`; the funding coin must NOT be the gas-payment object or the tx aborts (object used as both gas + input). Enforce with explicit `tx.setGasPayment(<distinct coin>)` or fund from a split that excludes the gas object. (Payday exec itself is safe — `pay_one` takes no coin input; funding lives in `Payroll.funding`. The window is setup-time only.)
6. `add_employee<SUI>(...)` × 3 — distinct addresses, small gross (sub-MIST-safe values), withholding_bps e.g. 1000.
7. Write `ts/testnet.json`.

**Object-id extraction (I5, two-step)**: 1.45.2 effects expose `changedObjects: ChangedObject[]` with `idOperation` and `outputOwner` — **no type string** on the entry. So: (a) filter `changedObjects` by `idOperation === 'Created'`; (b) split shared (`outputOwner.$kind === 'Shared'` → Payroll, TaxEscrow, vaults) vs owned (`'AddressOwner'` → PayrollOwnerCap, AdminCaps); (c) follow-up `client.core.getObjects({ objectIds })` and read each `.type` to disambiguate which shared id is Payroll vs TaxEscrow vs which vault. One round-trip extra; "match by type string off effects" (original §5) is not possible.

## 6. Deploy step

Manual, recorded:
- `sui move build` → `sui client publish --gas-budget <N>`.
- Capture `packageId` (and `UpgradeCap` id) from output into `ts/testnet.json` and `move-notes.md`.
- Why manual: publish is a one-time, gas-spending, human-confirmed action; scripting it adds risk without payoff for a hackathon testnet deploy.

## 7. e2e (`e2e-payday.ts`)

1. Load `ts/testnet.json` + build `PaydayConfig`.
2. Fetch FX scalars (existing `getFxScalars`) for the employees' pairs.
3. `buildPayday(employees, fxByPair, config)` → plan.
4. `executePayday(plan, payrollId, signer, makeGrpcPaydayClient(...), { expectedPeriod })`.
5. Assert: all receipts `status:"success"`, `completed:true`, on-chain `current_period` advanced by exactly 1, each employee `last_paid_period == period`.
6. **Resume smoke**: run with `resumeFrom` mid-plan against an already-begun period; assert no double `begin_period`, no double-pay (the period gate + `EAlreadyPaidThisPeriod` backstop both hold).
7. **H1 assertion (S6 — rigorous, offline)**: a green multi-chunk run does NOT prove `mutable:false` (a clock mis-resolved as mutable only over-locks `0x6` into consensus per-tx; sequential single-signer txs both still succeed without contention). Instead, after `await tx.build({ client })`, **inspect the serialized `TransactionData` inputs and assert the `0x6` SharedObject input has `mutable === false`** — deterministic, no chain needed. The resolver derives this from the ABI (`resolveTransactionPlugin` → `getMoveFunction` → `parameters[i].reference: 'immutable'` for `&Clock`), so it's expected to pass. Fallback if it doesn't: builder emits `tx.sharedObjectRef({ objectId:'0x6', initialSharedVersion:1, mutable:false })` (clock's `initialSharedVersion` is `1`).

## 8. Phase C gas (`gas-bench.ts`)

- Add 50 and 100 employees to a fresh payroll (or reuse with more `add_employee`).
- Run paydays at N = 3 / 50 / 100; record `gasUsed` per chunk from receipts.
- Output a table; flag if a 50-employee single PTB approaches the per-tx object-mutation / computation ceiling. Recommend keeping or lowering `MAX_BATCH`.
- This calibrates the provisional `MAX_BATCH=50` (`types.ts:5`).

## 9. Error handling

- **Setup failures fail loud** — any missing created-object after a setup tx throws with the tx digest; no silent partial config.
- **Adapter never swallows** — Move aborts surface as the `error` string in `DryRunResult` / `ExecResult`; the executor's fail-stop turns them into a `failure` receipt + `nextResumeFrom`.
- **Config drift** — `testnet.json` missing/partial → the e2e/bench scripts throw before touching the chain.

## 10. Testing strategy

- **Unit** (`grpc-client.test.ts`, vitest, no chain): the pure parts — status mapping (`effects.status.success===false` → port sentinel `"FailedTransaction"`), gas formula (`comp+storage-rebate` from string fields), `current_period` view-return decode, H1 offline assertion (`mutable===false` on built clock input). Inject a fake `Experimental_CoreClient` surface.
- **Integration / e2e** (`e2e-payday.ts`, live testnet): the full happy path + resume.
- **Monkey** (per project test rule): empty-funding payday (expect `EInsufficientFunding` fail-stop receipt, no period corruption); resume past end; wrong `expectedPeriod` (gate throws); double-run the whole plan (gate blocks re-`begin_period`).
- Existing 51/51 vitest must stay green (0 regression); the adapter is additive.

## 11. Risks / open

- **H1**: verified offline by asserting `mutable===false` on the built `TransactionData` clock input (§7.7), not by a passing run. Expected to pass (ABI-derived). Fallback = builder `sharedObjectRef(...mutable:false, initialSharedVersion:1)`, re-test Phase A.
- **`SuiGrpcClient` API surface — verified against installed 1.45.2 source** (sui-architect review, 2026-06-21): `client.core` is `GrpcCoreClient extends Experimental_CoreClient`. Confirmed shapes: `effects.status: ExecutionStatus = {success:true}|{success:false,error}` (NO `kind`/`FailedTransaction`), `effects.gasUsed: GasCostSummary` (4 string fields), `waitForTransaction({digest,timeout,signal})`, `dryRunTransaction({transaction: Uint8Array})`, `getObjects().type`, `changedObjects[].{idOperation,outputOwner}`. The §2 Rule-7 correction is the load-bearing reconciliation.
- **Scope size**: deploy + adapter + e2e + gas is large for one chat. Checkpoint after each of A/B/C; may split.
