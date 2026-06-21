# Sluice — Employer Dashboard (Frontend Sub-project #0 + #1)

_Date: 2026-06-21_
_Status: design approved, pending spec review_

## Scope

Frontend roadmap (#9) decomposed into 3 independent sub-projects, each its own spec→plan→build:

| # | Sub-project | Depends on | This spec |
|---|---|---|---|
| **0** | Shared frontend foundation (Vite + React + dApp-kit, wallet connect, orchestrator wiring, testnet config, shared UI) | backend ready | ✅ here |
| **1** | Employer Dashboard (roster, employee CRUD, fund, one-click Run Payroll) | #0 | ✅ here |
| 2 | Auditor view (read-only `PayrollEventV1` query/replay) | #0 | separate chat |
| 3 | Employee PWA + zkLogin + sponsored tx + allocation sliders | #0 | separate chat |

**This spec covers #0 (foundation) + #1 (Employer Dashboard) merged** — the foundation cannot be validated without a real surface driving it, so they ship together. #2 and #3 each get their own spec later.

## Goals

- Employer connects a standard browser wallet (holds `PayrollOwnerCap`), manages employees, funds the payroll, and runs an atomic payday — all against testnet, reusing the already-verified `@payroll-flow/orchestrator`.
- Establish the shared foundation (#0) every later surface builds on: ports, client setup, testnet config, dapp-kit signing adapter.

## Non-goals

- zkLogin / sponsored transactions / Employee PWA (→ #3).
- Auditor receipt export (→ #2).
- Production USDC (testnet uses `0x2::sui::SUI`; GTM switches type-arg only).
- A backend service. **Fully on-chain reads** (verified feasible below); a `PayrollReader` port leaves a seam to add a cache backend later without touching consumers.

## Data-source decision (verified)

Fully on-chain is feasible — **no backend needed**.

- **Read path**: `Payroll.employees` is `Table<address, EmployeeRecord>`. Every payday field lives on-chain in `EmployeeRecord` (`employee`, `jurisdiction`, `gross`, `withholding_bps`, `allocation: AllocationConfig{liquid/scallop/navi bps, pending}`, `last_paid_period`, `active`). Read off-chain via `getDynamicFields` (table id) + `getDynamicFieldObject` per entry.
- **Write path**: all employer ops are on-chain entry funcs — `create_payroll`, `fund`, `add_employee`, `set_gross`, `set_ratios`, `begin_period`, `pay_one` (via `executePayday`).
- **Only off-chain bits**: live Pyth FX fetch (already built, #7) + a small static `jurisdiction → fx_pair` map (not a DB).

Per user: prefer fully on-chain (opt 1); fall back to a lightweight backend (opt 3) only if infeasible — it is feasible, so opt 3 is not triggered. The `PayrollReader` port preserves the upgrade seam regardless.

## Architecture

```
SuiClient (JSON-RPC, testnet)
   │
   ├── PayrollReader (port)
   │     ChainPayrollReader: getDynamicFields(employees table) → EmployeeRow[]
   │     (future: swap impl for cache backend; consumers unchanged)
   │
   ├── orchestrator (@payroll-flow/orchestrator, existing/verified)
   │     getFxScalars → buildPayday → executePayday(plan, ..., PaydayClient)
   │
   └── Pyth FX (existing hermes adapter)
```

### Monorepo

- New sibling package `web/` next to `ts/`. Root `pnpm-workspace.yaml` lists `ts`, `web`.
- `web/` imports `@payroll-flow/orchestrator` via the workspace (reuse `buildPayday` / `executePayday` / `getFxScalars`).
- Stack: Vite + React + TypeScript (strict) + `@mysten/dapp-kit-react` + `@tanstack/react-query`.
- Testnet config: reuse the shape of `ts/testnet.json` (packageId / payrollId / escrowId / coinType). Public on-chain ids may live in a committed `web/src/config/testnet.ts`; secrets stay out of git.

### The one core change to existing code

`executePayday` takes a `PaydayClient` port (currently `grpc-client`, CLI keypair signing). Add a **`DappKitPaydayClient` adapter** that signs via the dapp-kit `useSignAndExecuteTransaction` hook (browser wallet) instead of a CLI keypair. This is an additive adapter — the executor core and port are untouched. Lives in `web/` (it depends on React hooks), not in `ts/`.

## Components / pages

- **Connect + Payroll picker** — wallet connect; select existing payroll or `create_payroll`; show whether the connected address holds the matching `PayrollOwnerCap`.
- **Roster table** — employee list from chain (payee, gross, withholding_bps, allocation bps, active, last_paid_period).
- **Employee CRUD** — `add_employee` form, `set_gross`, `set_ratios` (each its own tx; full CRUD per user).
- **Fund panel** — `fund` the payroll from a selected coin.
- **Run Payroll** — fetch Pyth FX → `buildPayday` → `executePayday` (chunked, resume-safe). `begin_period` is already prepended into chunk[0] by the executor. UI signs each chunk sequentially (wallet popup per chunk), shows progress, receipts, net gas, period 0→1. Double-run blocked by `PeriodGateError` (already verified on-chain).
- **Receipts / status** — last payday result, period-gate state.

## Run Payroll flow (core path)

1. Operator picks the active employees for this payday.
2. Fetch live Pyth FX scalars for the needed pairs (`getFxScalars`).
3. `buildPayday(employees, fxByPair, config)` → `PaydayPlan` (chunks ≤ `MAX_BATCH=50`).
4. `executePayday(plan, payrollId, signer=DappKitPaydayClient, client, opts)` — sequential chunk submit; chunk[0] carries `begin_period`; resume-safe via `resumeFrom`; optional `expectedPeriod` gate hard-blocks an accidental second `begin_period` (the money-safety boundary, not a gas optimization).
5. Render structured receipts + net gas; reflect period advance.

## Error handling

- `PeriodGateError` → surfaced as "already paid this period", not a silent retry.
- Wallet rejection mid-payday → stop, show which chunks landed (`resumeFrom`), offer resume — never re-run from scratch (re-running chunk[0] re-bumps the period → double-pay risk).
- Missing/own-mismatch `PayrollOwnerCap` → block write actions with a clear message.
- FX fetch failure → block Run Payroll (fail loud), do not pay with stale/missing rates.

## Testing

- orchestrator port logic: existing vitest (unchanged).
- `ChainPayrollReader` parsing: vitest against mocked dynamic-field responses (encode WHY: a misparsed `gross`/`bps` pays the wrong amount).
- `DappKitPaydayClient`: unit-test the adapter shape against the `PaydayClient` port contract.
- UI happy path: manual testnet e2e with the existing `scripts/e2e-payday.ts` as the on-chain oracle; Playwright smoke optional.
- Monkey testing (project rule): wallet rejection mid-chunk, double Run Payroll, empty roster, employee with 0 gross, fund with insufficient balance.

## UI quality

Hackathon judged on demo → use the `frontend-design` skill for a polished, distinctive UI (brand: **Sluice**, water/sluice-gate motif) rather than a bare functional version.

## Open / deferred

- gRPC full upgrade still pending SDK fix (orchestrator stays JSON-RPC; unaffected here).
- mock SUI → mainnet USDC type switch (GTM; type-arg only).
- #2 Auditor and #3 Employee PWA each get their own spec/plan/build cycle.
