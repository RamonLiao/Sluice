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

## Sui integration hardening (sui-architect review)

Full review: `docs/specs/2026-06-21-employer-dashboard-spec-review.md`. The orchestrator seam already encodes the safety primitives — these are about the `DappKitPaydayClient` adapter + UI **not regressing** them.

**Critical**

- **C1 — `DappKitPaydayClient` MUST build→sign→execute→`waitForConfirm` strictly per chunk in a loop**, re-resolving owned inputs (owner cap + gas coin version) each iteration — exactly like `GrpcPaydayClient`. Never batch-build all chunks: `tx.build()` pins current versions of the owned cap/gas-coin; signing chunks 2..N one popup at a time references stale versions → `ObjectVersionUnavailableForConsumption`, or wallet auto-gas reuses the same gas coin across in-flight txs → equivocation, cap locked till epoch. (Single-chunk ≤50-employee demos hide this; it bites at chunk[1].)
- **C2 — Resume MUST hard-gate `begin_period`.** `begin_period` (payroll.move:176) unconditionally `+= 1`, non-idempotent. Wiring `expectedPeriod`/`resumeFrom` is **mandatory, not optional**: read `current_period` immediately before each Run/Resume, pass as `expectedPeriod`; pass `resumeFrom` so chunk[0] is **skipped, not rebuilt**, on resume. A second `begin_period` opens a new period where everyone is payable again → double-pay.

**Important**

- **I1 — `EmployeeRecord` decode.** Table value = `Field<K,V>` wrapper → record nests under `.value.fields` (one layer deeper than naive read). `allocation.pending` Move `Option` → `{vec:[]}`/`{vec:[…]}`. `jurisdiction: vector<u8>` is the FX-pair key byte array (wrong decode → wrong FX). All `u64` (`gross`/`current_period`/`last_paid_period`) arrive as JSON-RPC strings → parse with `BigInt`, never `Number`. Test against a **real captured response**, not a hand mock.
- **I2 — `getDynamicFields` pagination.** Page ≤50, follow `hasNextPage`/`nextCursor` (unrelated to MAX_BATCH chunk size). Single call silently truncates roster >50 → invisible, unpaid staff. Cursor loop + `multiGetObjects` for values.
- **I3 — `create_payroll` discovery.** No creation event; 3 objects created. Request `showObjectChanges`/`showEffects` from dapp-kit signAndExecute, disambiguate by `objectType` (not array order), cross-check created cap id against `Payroll.owner_cap_id`. (Backend `PayrollCreated` event = nice-to-have, would also feed #2.)
- **I4 — Owner-cap gate is two-way.** Mirror on-chain `assert_owner` (payroll.move:302): connected address owns a `PayrollOwnerCap` with `payroll_id == selected` AND cap object id `== Payroll.owner_cap_id`. "Holds a cap" alone greenlights writes the chain will abort.

**Nice-to-have**: N1 UI invariant — rejected chunk[0] ⇒ full retry OK, rejected chunk[N>0] ⇒ resume-only (full re-run disabled). N2 `fund` coin ≠ gas coin. N3 read path prefer GraphQL/gRPC over JSON-RPC (deprecated 2026-07-31) behind `PayrollReader`.

## UI quality — design direction "The Headgate"

Full brief integrated below; built with the `frontend-design` skill. Brand **Sluice**. Reject generic AI aesthetic (no glassmorphism, no purple→blue gradients, no floating rounded cards, no hero+3-feature-cards, no Inter).

**Concept**: engineered-water / control-room — a dam-telemetry / financial-terminal gatehouse, NOT soft aqua/wave clichés. The CFO is the gatekeeper; payday is a physical lever pull that opens the headgate and branches money into measured outflows. Reads as serious money infrastructure = the trust signal payroll needs.

**Color** (instrument-panel dark, wet slate not navy-purple): `--ink #0B1418` bg, `--panel #11212A`, `--panel-edge #1E3A44` (1px hairline), `--channel #0E2A33`, `--mist #9FB6BE` (2nd text), `--chalk #EAF2F2` (text), `--flow #2FD4C4` (oxidized-copper teal, structural/live-state only). **Four allocation streams — fixed global identity colors reused in roster meter, sliders, flow viz, later auditor**: tax `--tax #E2B13C` (brass), liquid `--liquid #5BC8F5`, scallop `--scallop #7AE08B`, navi `--navi #F2784B` (burnt orange — deliberately NOT purple, dodges AI tell). Abort/gate `--gate-red #FF5247`.

**Type**: telemetry numerals = tabular monospace (Berkeley Mono / Departure Mono) for EVERY money/bps/gas/address/period figure. Headings = grotesque with character (Neue Haas Grotesk Display / Schibsted Grotesk / Hanken Grotesk) — NOT Inter, NOT Space Grotesk. Uppercase micro-labels `letter-spacing:0.08em` for panel headers.

**Density**: terminal-tight pro tool. 8px grid, 40–44px roster rows, no big rounded cards in whitespace — framed bezel panels with 1px machined edges + corner tick-marks. Radius ≤4px.

**Signature Run Payroll moment (wow shot)**: a docked **headgate console** with a physical lever/valve (not a flat button). State machine: (1) **Armed** — empty channel trough above roster, funded balance shown as "head pressure" fill bar, lever glows flow-teal; (2) **Pull** — hold-to-confirm ~600ms, wallet popup per chunk; (3) **Flow** — animated liquid runs the channel then **forks into 4 labeled streams** into collecting basins; each employee row drains in sequence as its chunk confirms (flow particle → row fills with its 4 stream-colors ∝ bps); net-gas + period 0→1 tick in mono on the console; (4) **Sealed** — gate closes, period locks with a brass seal; second pull → `PeriodGateError` → lever physically won't move + "PERIOD SEALED". Use Motion (React), one orchestrated sequence.

**Roster as manifest/ledger strip** (not admin DataTable): full-bleed hairline rows, no zebra; each row carries an inline **4-segment allocation meter** (tax/liquid/scallop/navi widths = bps) doubling as legend; mono right-aligned money; address = truncated mono + status dot (active flow-teal / paused mist / never-paid hollow ring); `last_paid_period` as tally/gauge not a number cell. **CRUD**: right-side "gate config" inspector drawer (not modal-over-dim); add-employee = inline materializing row at top; set_ratios = four linked sliders summing into the same 4-segment meter (must total 10000 bps; bar turns gate-red if over).

**Layout skeleton**: left thin vertical rail (payroll identity, OwnerCap status dot, period odometer); center manifest strip under the funded "head pressure" channel; right contextual gate-config drawer; bottom headgate console (lever + live telemetry). No top nav bar — rail + console frame it like equipment.

**Anti-AI-slop rules**: (1) no glassmorphism / purple-blue gradients / floating rounded cards — matte slate panels, 1px machined edges, corner ticks. (2) every number tabular monospace. (3) teal earned not sprinkled — at rest the UI is 90% slate+chalk+4 stream colors. (4) no generic hero / 3-card row / centered empty-state — empty payroll = empty channel "NO HEAD PRESSURE — FUND TO ARM". (5) the 4-color allocation system is sacred + global. (6) Run Payroll is a lever with a physical commit gesture, never a flat primary button.

## Open / deferred

- gRPC full upgrade still pending SDK fix (orchestrator stays JSON-RPC; unaffected here).
- mock SUI → mainnet USDC type switch (GTM; type-arg only).
- #2 Auditor and #3 Employee PWA each get their own spec/plan/build cycle.
