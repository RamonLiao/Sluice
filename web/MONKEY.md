# Monkey-Testing Pass — Task 14

**Date:** 2026-06-22  
**Branch:** main

---

## Checklist

### 1. Empty roster → "NO HEAD PRESSURE — FUND TO ARM", Run disabled

**Status: FIXED**

- `Roster.tsx:19-25` — empty-state label already rendered when `rows.length === 0`.
- **Gap found:** `HeadgateConsole.tsx` `leverDisabled` (was line 133) did NOT check for empty active roster.
- **Fix:** Added `activeRows.length === 0` to `leverDisabled` guard (`HeadgateConsole.tsx:133`).
- **Fix:** Added "NO HEAD PRESSURE — FUND TO ARM" message below lever when `account && ownerCapOk && activeRows.length === 0`.
- Evidence: `web/src/components/HeadgateConsole.tsx:133-134`

---

### 2. set_ratios summing ≠ 10000 → STAGE disabled + gate-red

**Status: PASS-code**

- `RatioSliders.tsx:9-13` — `ratioError()` returns `"ratios must sum to 10000 bps"` when sum ≠ 10000.
- `GateConfigDrawer.tsx:232` — `disabled={busy || ratioError(ratios) !== null}` — button disabled.
- `RatioSliders.tsx:53-55` — error text rendered in `var(--gate-red)` when `err` is non-null.

---

### 3. Connected wallet without OwnerCap → all write buttons disabled, rail dot gate-red

**Status: PASS-code**

- `Rail.tsx:26-30` — dot is `var(--gate-red)` when `ownerCapOk === false`.
- `App.tsx:131` — ADD EMPLOYEE button hidden when `!ownerCapOk`.
- `App.tsx:150` — `GateConfigDrawer` not rendered when `!ownerCapOk`.
- `FundPanel.tsx:140` — FUND button `disabled={busy || !account || !ownerCapOk}`.
- `HeadgateConsole.tsx:133` — lever `disabled` includes `!ownerCapOk`.

---

### 4. Fund with no sufficient coin → loud error, no silent no-op

**Status: PASS-code**

- `FundPanel.tsx:20-33` — `pickFundCoin()` throws `Error("FundPanel: no coins found…")` or `Error("FundPanel: no distinct fund coin…")`.
- `FundPanel.tsx:84-86` — catch block sets `error` state and renders `role="alert"` div in red.
- Unit tests: `FundPanel.test.ts` covers empty list, single coin, insufficient balance.

---

### 5. Employee gross=0 → included, pays 0 (matches Move)

**Status: PASS-code**

- `run-payday.ts:31` — `const active = args.rows.filter((r) => r.active)` — no gross filter.
- `run-payday.ts:32` — all active rows (regardless of gross) are passed to `buildPayday`.
- New unit test added: `run-payday.test.ts` "includes active employee with gross=0 — no gross filter (matches Move)".

---

### 6. Double Run Payroll → PeriodGateError → "PERIOD SEALED", lever disabled

**Status: PASS-code (manual full-path)**

- `HeadgateConsole.tsx:100-103` — `catch (e)` block: `if (e instanceof PeriodGateError) { setGate("sealed"); setMsg("PERIOD SEALED"); }`.
- `HeadgateConsole.tsx:131-133` — `sealed = gate === "sealed"` → `leverDisabled` includes `sealed`.
- **Full path (double-click testnet):** MANUAL — requires two live `run_payroll` calls in the same period on testnet.

---

### 7. Wallet rejects chunk[0] → full retry; rejects chunk[N>0] → RESUME only (N1)

**Status: PASS-code (manual full-path)**

- `HeadgateConsole.tsx:51-58` — N1 hard guard: `if (partialRun.current && resumeFrom === 0) { setMsg("RESUME ONLY…"); return; }`.
- `HeadgateConsole.tsx:86-97` — after non-completed run: `if (next > 0) { partialRun.current = true; }`.
- `HeadgateConsole.tsx:140-144` — lever label shows `RESUME PAYDAY (from chunk N)` when `partialRun.current`.
- **Full path (>50 employees, mid-chunk rejection):** MANUAL — requires testnet with enough employees.

---

### 8. Wallet rejection mid-chunk → failure surfaced, not silent success

**Status: PASS-code**

- `dappkit-payday-client.ts:34-41` — `signAndExecute()` wraps `signAndExecuteFn` in try/catch; on throw returns `{ kind: "FailedTransaction", … }`.
- `HeadgateConsole.tsx:62-66` — `signAndExecuteFn` itself throws if `result.$kind !== "Transaction"` (wallet rejection).
- Orchestrator receives `FailedTransaction` and surfaces it through `PaydayResult.receipts[n].status === "failure"`.
- `HeadgateConsole.tsx:257-264` — per-chunk receipt log renders failure in `var(--gate-red)`.

---

## Summary

| # | Item | Status |
|---|------|--------|
| 1 | Empty roster lever disabled | **FIXED** |
| 2 | Ratio sum guard | PASS-code |
| 3 | No OwnerCap write gate | PASS-code |
| 4 | No sufficient coin loud error | PASS-code |
| 5 | gross=0 included | PASS-code |
| 6 | Double run PERIOD SEALED | PASS-code + MANUAL |
| 7 | N1 resume-only invariant | PASS-code + MANUAL |
| 8 | Rejection surfaced | PASS-code |

**PASS-code: 8 | FIXED: 1 | MANUAL: 2 (items 6 & 7 full-path)**
