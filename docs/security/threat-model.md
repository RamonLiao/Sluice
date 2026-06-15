# PayrollFlow — Threat Model

> Companion to `docs/specs/2026-05-30-payroll-flow-spec.md`. Scope: MVP core modules
> (`payroll`, `allocation`, `escrow`). Mock vaults are in scope for fund-safety, out of scope for
> yield-economics realism. Per `.claude/rules/skill-routing.md`, core contracts get `sui-red-team`.

## Assets at risk
- A1 — Employer funding pool (`Payroll.funding: Balance<USDC>`).
- A2 — Withheld tax float (`TaxEscrow` per-jurisdiction balances).
- A3 — Employee yield positions (sCoins held by employee; Navi address-keyed positions).
- A4 — Allocation ratios (employee's intent; integrity = correct routing).
- A5 — Compliance event integrity (auditor/tax/legal reliance).

## Trust boundaries
- Employer multisig holds `PayrollOwnerCap` — trusted to fund/run, NOT trusted to touch employee yield.
- Employee holds `AllocationCap` — trusted only over own ratios + own withdrawals.
- Orchestrator (off-chain TS) — assembles PTBs; cannot bypass on-chain checks (untrusted for safety).
- Pyth — trusted price source within a 60s freshness window.

## Attack vectors & defenses

| # | Vector | Target | Likelihood | Impact | Defense (design-level) |
|---|--------|--------|-----------|--------|------------------------|
| V1 | Employee stages a slider change to dump withholding/route 100% liquid right before payday | A4/A2 | Med | Med | D10: `AllocationConfig.effective_from_period` — changes staged to `pending`, promoted only when `current_period` advances (bumped once per payday by `begin_period`). Payday reads the committed snapshot. **Epoch-based staging rejected**: Sui epochs (~24h, auto-advancing) decouple from payday cadence, so a day-before change would take effect. (`SPEC §9.1 / D10`) |
| V2 | Forged/replayed `PayrollOwnerCap` runs payday or drains funding | A1 | Low | High | Every mutating fn asserts `cap.payroll_id == payroll.id` (`E_NOT_OWNER`). Cap on 2-of-N multisig. Caps are non-copyable `key,store` objects. |
| V3 | Value leak — net + withholding ≠ gross, attacker skims the gap | A1/A3 | Low | High | Linear coin types: `pay_one` splits one `gross_coin`; liquid is the remainder. Sum is structural, not arithmetic. `withholding_bps ≤ 10000`, ratios Σ == 10000 (`E_RATIOS_SUM`, `E_WITHHOLDING_RANGE`). |
| V4 | Stale/wrong FX → wrong jurisdiction conversion in compliance record | A5 | Low | Low | D9: FX is **reporting-only** (not in USDC value path), so it cannot corrupt value movement. <60s check sets `fx_stale=true` in `PayrollEventV1` + records publish_time/price for forensic replay; payday **does not abort**. Aborting all pay on a reporting-only oracle would itself be the DoS (cf. V5). `E_STALE_FX` removed. |
| V4b | FX-abort weaponized as payroll-wide DoS (old design) | A1 (liveness) | — | — | Eliminated by D9 — see V4. Listed to record the rejected design. |
| V5 | Vault outage aborts the entire N-employee payday (DoS) | A1 (liveness) | Med | High | D8: `route()` reads vault `active`; inactive vault → that bucket folds into the employee's liquid coin. No abort, no partial-pay. |
| V6 | Employee A withdraws against employee B's Navi position (address-key confusion) | A3 | Low | High | `mock_navi.withdraw` keys strictly on `ctx.sender` — pays out `positions[sender]` only (NOT cap-gated; ownership is the address itself, see SPEC §6); `E_VAULT_PRINCIPAL` on over-withdraw. Scallop exposure is a bearer sCoin → holding the coin is the claim. |
| V7 | Escrow remittance to wrong/attacker address | A2 | Low | High | `remit` requires `PayrollOwnerCap`; destination is an explicit arg surfaced in UI; multisig approval. |
| V8 | PTB object-limit overflow at large headcount → unbounded gas / failed run | A1 (liveness) | Med | Med | Orchestrator caps 50 employees/PTB; >50 splits into N PTBs. Tested 3/50/100 (`SPEC §11`). |
| V9 | Post-upgrade old module version mutates shared object with deprecated logic | A1/A3 | Low | High | D11: `Payroll`/`TaxEscrow` carry `version: u64`; every mutating entry `assert_version` against the module `VERSION` const (`E_WRONG_VERSION`). One-shot `migrate` bumps the object version on upgrade, fencing off the old version immediately. |
| V10 | `gross * withholding_bps` overflows u64 at very large gross | A3 | Low | Med | Computed in u128 intermediate then cast back (`SPEC §5`). Monkey test covers gross near `u64::MAX`. |

## Out of scope (MVP, documented)
- Real yield-rate accuracy, liquidation, oracle manipulation of Scallop/Navi — mocked; revisit at mainnet
  adapter swap (`SPEC §12`).
- EOR / KYC / regulatory custody — MVP is 1099-contractor scope only (`BUSINESS_SPEC §7`).
- Multi-employer collision on one address — schema-ready (D5) but not exercised in MVP.

## Residual risk
- Mainnet Navi beneficiary-credit problem (sender/`AccountCap` vs arbitrary employee) is an **open migration
  task**, not solved in MVP. Tracked in `move-notes.md` before GTM.
- Employer multisig misconfiguration is an operational risk mitigated by UI pre-flight, not by Move.
