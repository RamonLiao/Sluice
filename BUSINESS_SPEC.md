# PayrollFlow — Business Spec

> Track 1 · DeFi & Payments · Sui Overflow 2026
> One-liner: Cross-border Web3 payroll that atomically pays salary, withholds tax, and auto-allocates each employee's pay into yield + savings + spendable buckets — in one PTB.

---

## 1. Executive Summary

PayrollFlow turns a payroll run into a single Programmable Transaction Block. An employer funds a `Payroll` Move object with USDC; on payday, one PTB iterates every active `Employee` object and atomically: (a) transfers net salary, (b) reserves the employer-side tax withholding into a segregated escrow, (c) routes each employee's pre-configured allocation into Scallop / Navi yield vaults, a BTC-index position, and a liquid spendable balance — all in the same transaction. Employees control their own allocation ratios via an `AllocationCap` they hold; employers never custody employee yield exposure. Compliance metadata (period, jurisdiction, gross/net split, FX rate snapshot) is recorded on-chain for auditor replay.

This collapses what is normally a 5-system workflow (ADP/Deel for payroll → bank wire → personal wallet → CEX → DeFi protocol) into a 400ms on-chain event with deterministic, auditable atomicity. The category target is the **~$32B global payroll services market** [source: Mordor Intelligence, Global Payroll Market 2024-2029] and the **$1B+ crypto-payroll cohort** already proven by Bitwage ($4.5B cumulative volume, acquired by PayStand 2025-11), Rise ($1B+ processed by 2026-03), Request Finance ($1B crypto payments 2025), and Toku ($34.8M revenue, SGX IPO 2026-01) [source: Rise 2025 Payroll Report; Bitwage; Toku IPO Prospectus].

**Win probability**: 83/100 per internal IDEA_REPORT. Highest "story" score in Track 1, but lowest "live users by demo day" — judges can't onboard a real company on stage. The PTB-atomic multi-leg payroll demo is the differentiator that compensates.

---

## 2. Problem Statement

Web3 payroll today is a stitched-together hack across five disconnected systems:

- **SWIFT is the wrong rail.** Cross-border wires settle in 1–5 business days, cost $25–50 per leg, and silently fail 4–8% of the time at intermediary banks. For a 40-person distributed team paid bi-weekly across 12 countries, the operational cost dwarfs the headcount cost line.
- **Crypto payroll providers fix the rail but not the loop.** Bitwage, Rise, Request Finance, and Toku ship stablecoin to a wallet — then the employee manually moves it to savings, manually buys BTC, manually deposits into Aave. Each manual step is a churn risk and a tax-event headache.
- **Tax withholding is fragmented from pay.** Employers compute withholding in their payroll system, then wire it separately to tax authorities (or worse, ask employees to self-report). No atomic guarantee that the net + withholding sum equals gross — exactly the kind of error a single PTB eliminates.
- **Employees can't programmatically split their own pay.** Even the most crypto-native employees end up rebuilding the same "split salary into 4 buckets" script in Zapier or Python. There's no standard primitive for "auto-allocate my pay on receipt."
- **B2B compliance demand is unmet.** Finance teams need cryptographic proof that "Employee X received Y USDC on date Z, with W withheld for jurisdiction J" — for SOC2, for tax audits, for SAFE / convertible-note investor reporting. SWIFT statements don't provide it; CSV exports from Deel only partially do.

Sui is uniquely positioned because PTBs make the "transfer → withhold → split → invest" pipeline a single atomic event, Move objects let employees own their own `AllocationCap`, and zkLogin + Sponsored TX let an employee onboarded yesterday receive crypto pay today without ever touching a seed phrase.

---

## 3. Target Users & Personas

### Persona A — Web3-Native Startup CFO ("Sara, COO at a 25-person crypto-AI startup, contributors in 9 countries")
- AUM context: $6M raised, $400k/mo burn, ~$180k/mo in contributor pay.
- Pain: currently uses Deel for compliance ($600/yr per contractor) + manual USDC transfers for early hires; reconciliation eats 4 hours/week.
- Wants: one button labelled "run payroll," cryptographic receipts for the investor data room, no SWIFT.

### Persona B — Distributed Tech Company HR Lead ("Marco, People Ops at a 120-person remote-first SaaS")
- Already pays via Remote.com EOR; explores stablecoin to retain LatAm engineers facing local inflation.
- Pain: Remote charges $599/contractor/mo, FX conversion eats another 1.5%, employees ask for USDC because peso lost 35% YoY.
- Wants: hybrid payroll — fiat where regulated, USDC where employees prefer; same dashboard.

### Persona C — Crypto-Native Employee ("Aiko, software engineer at Persona A's startup")
- Receives $7k/mo USDC; manually splits 30% to Aave, 20% to BTC, 10% to savings, keeps 40% liquid.
- Pain: 4 tx/mo × ~$3 each on Ethereum + 25 minutes/mo + 4 taxable events.
- Wants: declare allocation once, pay arrives pre-split, only one taxable event per pay period.

### Persona D — Auditor / Tax CPA ("Beatriz, fractional CFO serving 14 crypto startups")
- Pain: each client uses a different chain, different wallet provider, different export format; reconstructing a year of comp expense takes weeks.
- Wants: standardised on-chain pay receipt with employer ID + employee ID + jurisdiction + gross/net + FX snapshot, queryable in one indexer.

---

## 4. Use Cases

### UC1 — Atomic Payday Run (flagship)
Employer clicks "Run Payroll" → backend assembles one PTB with N branches (one per employee). Each branch: `transfer_net(employee_addr)` + `reserve_tax(escrow, withholding_amt)` + `route_allocation(allocation_cap_id, salary)` where `route_allocation` reads the employee's stored ratios and atomically splits into Scallop USDC, Navi BTC-index position, and a liquid `Coin<USDC>`. Tx lands in <400ms with one block-explorer URL the CFO can pin in the data room. If gross ≠ net + withholding + allocations, the entire PTB aborts — no partial pay disasters.

### UC2 — Employee Self-Service Re-Allocation
Aiko opens the PWA, drags a slider: "50% savings, 20% BTC, 30% liquid." This mutates her `AllocationCap` object; the new ratios apply from next payday with zero employer involvement. She can also pause allocations (entire salary → liquid) for one cycle when she has a big purchase.

### UC3 — Cross-Border Compliance Receipt
Beatriz queries the indexer: "Show all 2026-Q1 payments to jurisdiction = Argentina." Returns: per-payment gross, net, withholding amount + tax-authority destination, FX rate from Pyth at tx time, employer signature. Exports as PDF for tax filing. Replaces 3 days of Deel CSV reconciliation per client.

---

## 5. Market Analysis

### TAM / SAM / SOM
- **TAM** — global payroll services market: **~$32B in 2025**, projected $35.3B in 2026, CAGR 8.35–8.7% [source: Mordor Intelligence, Global Payroll Market 2024-2029]. Cross-border subset alone: **$5.1B in 2024 → $11.6B by 2033** (CAGR 12.3%).
- **SAM** — Web3-native + remote-first companies paying contributors in stables or willing to. Anchor: Deel hit **$1B ARR by Q1 2025** [source: TechCrunch], Remote **$600M revenue** (2023), Rippling **~$570M ARR** (2025-10) — combined cross-border addressable layer **~$2.5B/yr ARR** at current capture; Web3-native cohort **~$300M ARR** addressable based on existing players (Toku $34.8M ARR + Rise + Request Finance + Bitwage volume share) [source: Toku IPO Prospectus, SGX 2026-01].
- **SOM (year 1, hackathon → mainnet+12mo)**: Sui-native Web3 startups + design-partner cohort. Target: **20–80 paying companies, $100–500k MRR** (Internal projection — no external benchmark for Sui-native payroll). Anchor: Toku's $34.8M revenue came largely from a few hundred token-compensation clients; same TAM density.

### Competitive Landscape

| Provider | Atomic multi-leg pay+invest | On-chain audit trail | Stablecoin native | Tax withholding | Employee allocation control |
|---|---|---|---|---|---|
| Deel | No | No | Limited (1 token) | Yes (EOR) | No |
| Remote.com | No | No | No | Yes (EOR) | No |
| Rippling | No | No | No | Yes | No |
| Bitwage (PayStand) | No | Partial | Yes | Limited | Manual |
| Rise | No | Partial | Yes | Limited | Limited |
| Request Finance | No | Yes (invoice) | Yes | No | No |
| Toku | No | Partial | Yes | Yes (token comp) | No |
| **PayrollFlow** | **Yes (PTB)** | **Yes (Move event)** | **Yes** | **Yes (atomic escrow)** | **Yes (`AllocationCap`)** |

No incumbent combines atomic pay+invest+withhold in one transaction with employee-controlled allocation primitives. PTB makes it Sui-only.

---

## 6. Differentiation — Why Sui + PTB + Move Object Model

1. **PTB atomicity is the entire product**. "Pay + tax + invest" as one transaction has no equivalent on Ethereum without flashloan choreography. On Sui it's the default execution model.
2. **`AllocationCap` as a Move object** gives the employee a transferable, capability-gated handle to their own pay routing. Employer never touches it; auditor can verify ownership chain on-chain.
3. **Sponsored TX = employee onboarding without gas**. New hire signs in with Google (zkLogin), gets a derived address, receives their first salary that day — no SUI needed, no seed phrase. Removes the #1 churn point in Web3 payroll.
4. **Sub-400ms finality** means payday isn't an overnight batch — the CFO clicks at 5pm and sees confirmation before the next Zoom call.
5. **Composability with Scallop / Navi / DeepBook**: allocation router can plug into any vault that exposes a Sui-standard deposit interface; new yield venues become drop-in upgrades, not migrations.
6. **On-chain compliance trail beats SaaS exports**. A Move event log signed by the employer's address is more legally defensible than a Deel CSV that anyone with edit access can mutate.

---

## 7. Product Scope

### MVP (Hackathon, ~5 weeks)
- **`Payroll` + `Employee` + `AllocationCap` Move objects** with full unit tests.
- **Atomic payday PTB** routing salary → tax-escrow → 2 yield positions (Scallop USDC + Navi BTC-index proxy) → liquid Coin.
- **Employer dashboard** (Next.js): add employees, set gross + jurisdiction + withholding %, fund payroll, trigger run.
- **Employee PWA**: zkLogin onboarding, allocation slider, portfolio view, pay-history with receipts.
- **Demo flow**: 3 mock employees paid in one tx, live breakdown visualisation showing the split across 8+ object mutations in a single block.
- **One design-partner testimonial** if obtainable (video, 30s).

### v1 (post-hackathon, 8 weeks)
- **Real jurisdiction templates** (US 1099 contractor, EU freelancer, MX, AR, BR with VAT) — withholding tables baked in.
- **Sponsored TX for employees** so first onboarding is gas-free.
- **CSV/PDF audit export** for Beatriz persona.
- **Multi-currency funding** (USDC + USDT + USDsui via iron_bank).
- **Slack / Telegram payday notifications** to employees.

### v2 (Q4 2026)
- **EOR partnership layer**: white-label PayrollFlow under a regulated EOR for jurisdictions requiring full employer-of-record status.
- **DAO treasury mode**: governance-approved payroll runs for protocols paying contributors from treasury.
- **Stablecoin FX rail**: automatic conversion at Pyth rate when employee wants local currency settlement via on/off-ramp partners.
- **AI compliance assistant**: flags unusual pay changes, missing withholding, jurisdiction drift.

### Strategic call: contractor-first, EOR-second
MVP targets 1099-style contractor pay (no employer-of-record liability) because (a) zero legal blast radius, (b) Web3-native startups already use this model, (c) faster to ship and demo. EOR mode (v2) is where real enterprise revenue lives but requires regulated partner — won't ship from hackathon.

---

## 8. User Flow

### Employer onboarding (Sara, CFO)
1. Sign in to PayrollFlow with Slush / Suiet → connect company multisig.
2. Add company info (name, primary jurisdiction, default funding token).
3. Add employees: email + gross monthly + jurisdiction + withholding % (auto-suggested by jurisdiction template in v1).
4. Each employee gets a deeplink invite; on click, zkLogin + ephemeral wallet + `Employee` object minted to them.
5. Sara funds the `Payroll` object with USDC.
6. On payday: click "Run Payroll" → see PTB preview (N transfers, N escrows, N allocations) → confirm → block-explorer URL.

### Employee first pay (Aiko)
1. Open deeplink invite → sign in with Google → derived Sui address + `Employee` object + empty `AllocationCap` minted via sponsored PTB.
2. Set allocation defaults (the app suggests "50% liquid / 30% USDC yield / 20% BTC index" for new users).
3. At payday: push notification "Salary received. 50% sent to liquid, 30% supplied to Scallop, 20% routed to BTC index. View receipt." → tap → on-chain receipt + portfolio.
4. Anytime: drag allocation slider → next pay uses new ratios.

### Auditor query (Beatriz)
1. Sign in (read-only role per company).
2. Filter: company × period × jurisdiction.
3. Export PDF with cryptographic Merkle proof + per-employee gross/net/withholding/FX snapshot.

---

## 9. Technical Architecture (summary)

- **On-chain (Sui Move)**:
  - `payroll` module — `Payroll` shared object (employer-controlled), `Employee` owned object (held by employer registry but with employee-owned `AllocationCap`), `TaxEscrow` shared object per jurisdiction.
  - `allocation` module — `AllocationCap` capability (held by employee), `AllocationConfig` struct (vault address, ratio), `route()` function called from payday PTB.
  - `compliance` module — emits structured event per pay (employer_id, employee_id, jurisdiction, gross, net, withholding, fx_snapshot, period).
- **PTB orchestrator (TS backend)**: assembles per-employee branches, applies splits, batches up to 50 employees per PTB (Sui object limit), falls back to N batches if larger.
- **Yield adapters**: thin TS wrappers around Scallop SDK + Navi SDK exposing a uniform `deposit(coin) → receipt_object` interface. Adding DeepBook spot for BTC-index is a v1 add-on.
- **zkLogin + Sponsored TX**: Enoki SDK for employee onboarding + first-pay gas sponsorship.
- **Indexer**: custom Postgres ingesting `payroll::PayrollEventV1` events; powers auditor queries + employee dashboard + employer reconciliation.
- **Frontend**: Next.js employer dashboard + employee PWA + read-only auditor view.

No new infrastructure required beyond existing Sui + Scallop + Navi + Pyth (for FX snapshots).

---

## 10. Business Model

Three revenue lines, B2B SaaS-style:

1. **Per-employee monthly fee** — $12/employee/mo (vs Deel's $49–599/mo). Sweet spot for Web3-native startups that don't need EOR.
2. **Treasury yield take-rate** — 5–10bps on the tax-escrow float (employers' withheld tax sits in escrow for 1–90 days before remittance; that float earns yield, we share).
3. **Allocation fee (employee side, v1+)** — 5bps on auto-allocations to partner yield vaults, paid by the vault as a referral (Scallop / Navi pay for inbound flow).

Unit economics: 100 companies × 30 employees × $12 = **$36k MRR** + ~$10k/mo yield share + ~$5k/mo allocation rebate = **~$0.6M ARR** from a small cohort (Internal projection — no external benchmark for Sui payroll). Anchor: Toku reached $34.8M ARR with primarily token-grant compliance — payroll-as-product TAM is larger.

Cost structure: Sui gas (~$0.01/employee/payday), Enoki API, indexer hosting, withholding-table maintenance (1 part-time tax counsel by v1). Gross margin >85% by month nine.

---

## 11. Go-to-Market

- **Phase 0 — hackathon win**: shippable demo with 3 paid mock employees, 1 design-partner testimonial video. Win = grant + Foundation amplification of the "salary that streams and earns" narrative.
- **Phase 1 — design-partner cohort (weeks 6–12)**: lock 5 Sui-native or Sui-curious crypto startups as free beta — Mysten ecosystem grantees, Sui Foundation portfolio cos, Asia-Pac AI startups paying remote teams.
- **Phase 2 — paid GA (weeks 12–24)**: 20–50 paying companies, $12/employee tier. Direct sales + 2 Web3 HR advisor partners.
- **Phase 3 — channel via accelerators / VCs (months 6–12)**: offer free 6-month plan to portfolio companies of 3 Web3-focused VCs (a16z crypto, Pantera, Lightspeed Faction). They get a checkbox for their AI-native portfolio.
- **Phase 4 — EOR partnership (year 2)**: white-label under one or two regulated EORs in MX, BR, IN — true enterprise TAM unlock.

Anchor partnerships to pursue at hackathon: Scallop (yield-vault referral), Navi (BTC-index allocation), Pyth (FX snapshot), Slush wallet (employer multisig + deeplink invites).

---

## 12. Hackathon Demo Plan + Judging Mapping

### 7-minute demo script
1. (0:00–0:45) **Hook**: split screen — Deel UI (12 clicks across 3 tabs to run payroll for 3 contractors) vs PayrollFlow (one button, one PTB, three explorer URLs).
2. (0:45–2:00) **Setup**: pre-recorded 30s of CFO adding 3 employees + funding payroll with 10k USDC. Live continues from a funded state.
3. (2:00–4:00) **Run payroll**: click "Run Payroll" → live PTB lands on Sui testnet → block-explorer view shows 3 employees, each with 4 atomic operations (transfer + tax + 2 yield routes) in one block. Total: ~12 object mutations, ~400ms, one tx hash.
4. (4:00–5:30) **Employee view**: switch to Aiko's phone mirror → push notification arrives → open app → portfolio shows new pay already split across liquid / Scallop / Navi-BTC; drag slider to change ratios for next month.
5. (5:30–6:30) **Auditor view**: filter by jurisdiction → export PDF receipt with cryptographic proof; demonstrate that the receipt's gross/net/withholding sum-check matches the on-chain event exactly.
6. (6:30–7:00) **Pitch**: "$32B payroll market, $1B+ already crypto, zero competitors do atomic pay+invest. Sui is the only L1 where this is one tx" → ask for grant + EOR partner intro.

### Judging criteria mapping
- **Real-World (50%)** — $32B TAM with concrete B2B SaaS model + $1B+ proven crypto-payroll cohort to acquire from. Recurring monthly usage, not one-shot demos.
- **Technical Quality (20%)** — atomic multi-leg PTB with N×4 operations per payday; Move object capability design; Scallop/Navi/Pyth composition; on-chain event audit trail.
- **Innovation (15%)** — first payroll product where pay and investment are the same transaction; `AllocationCap` as a transferable Move primitive is genuinely new.
- **UX (10%)** — one-click employer payday + zkLogin employee onboarding; the demo's emotional beat is "click → done, with cryptographic receipt."
- **Sui Ecosystem Fit (5%)** — PTB + Move objects + zkLogin + Sponsored TX + Scallop + Navi + Pyth + Slush; uses more of the stack than almost any Track 1 project.

---

## 13. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Judges can't see "real users" by demo day | High | High | Lead with the design-partner testimonial video; show production-grade dashboard with realistic mock data; emphasise recurring B2B usage model vs one-shot demo |
| Rise / Toku / Bitwage entrenched + Toku just IPO'd | High | Medium | Differentiate on PTB atomicity + employee allocation primitive — neither competitor offers this; price 4–10× lower; target Web3-native cohort first |
| Compliance / KYC / EOR scope is a black hole | High | High | Explicitly scope MVP to 1099 contractor pay (no EOR); jurisdiction templates as v1; partner with regulated EOR for v2 only |
| B2B sales cycle = no paying users in 5 weeks | High | Medium | Free design-partner program (target 5 signed LOIs before judging) replaces "live users"; videotaped testimonial substitutes for live onboarding |
| Move object limits on PTB size (50 objects, gas budget) | Medium | Medium | Batch >50 employees across multiple PTBs in same block; tested at 100, 250, 500 mock employees |
| Tax-withholding amount disputed by jurisdiction | Medium | High | Withholding rates configured per jurisdiction template, reviewed by tax counsel before v1; surfaced in UI with disclaimers; employer signs off per period |
| Scallop / Navi vault outage breaks payday | Medium | High | Per-employee allocation has a fallback: if vault fails, that fraction lands in liquid Coin instead of aborting whole payday |
| Employee allocation slider abused (front-running employer payday) | Low | Low | `AllocationCap` mutations have a 1-block delay; payday uses snapshot at PTB build time |
| Pyth FX snapshot stale / wrong → wrong tax conversion | Low | Medium | Validate freshness < 60s in PTB; abort and retry if stale; auditor receipt includes Pyth signature for forensics |
| Employer multisig misconfigured → unauthorised payroll | Medium | High | Mandatory 2-of-N multisig for `Payroll` object owner; demo + docs emphasise; pre-flight check in UI |

---

## 14. Open Questions

1. **EOR partner selection** — which regulated EOR is willing to white-label first? Deel won't, Remote.com unlikely; mid-market players (Borderless, Multiplier) more likely candidates.
2. **Jurisdiction template scope for v1** — start with US + EU + LatAm (most Web3-native demand), or aim broader and rely on community contributions?
3. **Tax-escrow remittance** — automatic to tax-authority bank account (requires off-ramp partner), or hold and export for employer to wire? MVP probably the latter.
4. **Employee `AllocationCap` transferability** — should employees be able to delegate their allocation control (e.g. to a robo-advisor)? Likely yes in v2, no in MVP.
5. **Multi-employer support per employee** — can one Sui address hold multiple `Employee` objects from different employers? Need design decision before v1 schema lock.
6. **BTC-index implementation** — wrap DeepBook spot, integrate with existing BTC token on Sui, or use a hosted vault? Affects v1 launch date.
7. **DAO treasury payroll** — same product or separate vertical? Treasury payroll has different governance/multisig requirements.
8. **Pricing anchor** — $12/employee/mo undercuts Deel 4×; is the right move to undercut harder ($6) for adoption, or hold to capture B2B yield-share economics?
9. **Allocation slider UX** — percentage split vs absolute amounts vs hybrid? User testing required.
10. **Audit certification path** — is on-chain event log alone sufficient for SOC2 / Big Four sign-off, or do we need a complementary SaaS attestation layer?

---

*End of spec. ~2,400 words.*
