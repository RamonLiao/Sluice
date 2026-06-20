# PayrollFlow #8 — Payday Executor (TS orchestrator, Phase B)

_Design — 2026-06-20_

## Scope

Phase B of the #8 TS orchestrator: the **executor** that takes the unresolved
`Transaction` objects produced by the Phase A builder (`buildPayday`) and actually
signs, submits, and confirms them on-chain — sequentially, idempotently, and with
an audit trail.

GTM framing: payroll = money + legal records. The executor's value is **not** "can
sign and send" — it is **safe partial-failure recovery + auditable receipts**. The
design centers on that.

Builds on `2026-06-19-payday-ptb-builder-design.md` (Phase A). Hard contracts H1, H1b,
H2, H2b, H3 from that doc are the requirements this phase fulfils.

### Deferred (future, new chat each)
- **Phase C** — `dryRun`/`devInspect` gas measurement at 3/50/100 employees to calibrate
  the provisional `MAX_BATCH=50`. The preflight `dryRun` path here is reused (it already
  returns `gasUsed`).
- **Sponsored gas (GTM v2)** — see "Sponsored upgrade" below. Designed as a non-breaking
  seam; not implemented now.
- **Persistent job journal (GTM v2)** — caller persists `PaydayResult` for now (file/DB/job
  row). Journal is a layer on top of the same resume interface; not implemented now.

## The load-bearing safety fact: `begin_period` is NOT idempotent

`payroll::begin_period` (payroll.move:176-180) unconditionally does
`current_period = current_period + 1`. Consequences:

- `pay_one` guard (`last_paid_period < current_period`, payroll.move:239) only prevents
  paying the same employee **twice within one period**.
- It does **NOT** prevent re-payment after a new period opens. If chunk[0]
  (`begin_period` + 50 pays) confirms — period now 1, those 50 paid at period 1 — and the
  operator **re-runs the whole payday**, `begin_period` runs again → period 2 → those 50
  satisfy `last_paid_period(1) < 2` → **paid again. Double-pay.**

Therefore **resume is a safety boundary, not a gas optimization**. The executor must make
re-running `begin_period` for an already-started payday hard:

- `begin_period` lives only on `transactions[0]`. It runs **only** when `resumeFrom === 0`.
- `resumeFrom > 0` skips it — safe by construction.
- `expectedPeriod` (optional) turns "this is payday N" into an on-chain-checkable
  precondition (see §3) — the cheap defense that closes the re-run-from-zero hole without a DB.

## API

```ts
async function executePayday(
  plan: PaydayPlan,         // from buildPayday (Phase A); transactions[] order == submission order
  signer: Signer,           // @mysten/sui Signer — INJECTED. H3: must own ownerCap + gas coin.
  client: PaydayClient,     // narrow interface (below) — inject SuiClient in prod, mock in tests
  opts?: {
    resumeFrom?: number;     // chunk index to start at; skips already-confirmed chunks. default 0
    expectedPeriod?: bigint; // safety gate: the period this payday should pay at (see §3). optional
    preflight?: boolean;     // dryRun the resumeFrom chunk before committing money. default true
  },
): Promise<PaydayResult>
```

### Narrow client interface (dependency minimization + testability)

The executor depends on a narrow port, not the whole `SuiClient`. A real `SuiClient`
satisfies it; tests inject a mock.

```ts
interface PaydayClient {
  getCurrentPeriod(payrollId: string): Promise<bigint>;          // reads Payroll.current_period
  dryRunTransaction(tx: Transaction, signer: Signer): Promise<DryRunResult>;
  signAndExecute(tx: Transaction, signer: Signer): Promise<ExecResult>; // with showEffects
  waitForConfirm(digest: string): Promise<void>;                 // resolves after finality
}
```

(Exact adapter mapping to `@mysten/sui` `SuiClient` methods — `getObject` for
current_period, `dryRunTransactionBlock`, `signAndExecuteTransaction`,
`waitForTransaction` — is an implementation detail of the prod adapter.)

## Execution loop (§2) — H1/H1b/H2/H2b realization

```
const currentPeriod = await client.getCurrentPeriod(cfg.payrollId)   // 1 read
assertPeriodGate(currentPeriod, resumeFrom, expectedPeriod)          // §3

for (let i = resumeFrom; i < N; i++) {
  const tx = plan.transactions[i]
  if (i === resumeFrom && preflight) {
    const dry = await client.dryRunTransaction(tx, signer)
    if (!dry.ok) { record dryRun-failure receipt; return { completed:false, nextResumeFrom:i } }
  }
  const res = await client.signAndExecute(tx, signer)               // builds+resolves+signs+submits
  await client.waitForConfirm(res.digest)                           // H2: confirm before next
  if (res.effects.status !== "success") {
    record failure receipt(i, res.digest, res.error)
    return { completed:false, nextResumeFrom:i }                    // fail-stop, do NOT continue
  }
  record success receipt(i, res.digest, paidAtPeriod, gasUsed)
}
return { completed:true, nextResumeFrom:null }
```

- **H2 / H2b (ordering + equivocation)** solved by "send one → wait confirm → then next". The
  next tx is only built/resolved inside `signAndExecute` **after** the prior confirms, so the
  SDK fetches the **latest** owner-cap + gas-coin object versions → no equivocation.
  **Discipline: never pre-build/pre-sign all chunks** — resolve each one just-in-time.
- **H1 / H1b (lazy resolution + mutability map)** delegated to the SDK's ABI-based resolution:
  `signAndExecute` makes the SDK read `pay_one`'s normalized signature and infer shared-object
  mutability from `&mut` vs `&` (payroll/escrow/scallop/navi → mutable; clock 0x6 → immutable).
  **This MUST be verified by an integration test** (H1b: if the SDK marks Clock mutable, every
  payday serializes on the global Clock). If the SDK resolves it wrong, fall back to manually
  pinning shared refs. Do not pre-build that fallback — it's a verification gate, not default work.
- **Fail-stop**: a chunk is a PTB → on-chain all-or-nothing (no partial pay within a chunk).
  Any chunk failure stops the run, does not submit later chunks, and returns `nextResumeFrom=i`
  so the caller fixes the cause (gas/funding) and resumes from that point. Money fails loud.

## Safety gate + receipts (§3)

### `expectedPeriod` gate (`assertPeriodGate`)

```
fresh run (resumeFrom === 0) with expectedPeriod set:
    require currentPeriod === expectedPeriod - 1
    // else begin_period for this payday already ran → re-running double-pays → throw

resume (resumeFrom > 0) with expectedPeriod set:
    require currentPeriod === expectedPeriod
    // begin_period already landed; period must already be advanced. mismatch = state drift → throw

expectedPeriod omitted: skip the gate (pure resumeFrom behavior; fine for demo, weaker for GTM)
```

`expectedPeriod` is the minimal-cost upgrade from option-1 (resumeFrom) toward option-3
(journal): the caller tracks one monotonically increasing integer, no DB. When the journal
lands later it stores exactly `{ expectedPeriod, receipts }` — this interface is unchanged.

### Receipt types

```ts
interface ChunkReceipt {
  chunkIndex: number;
  digest: string | null;          // null = chunk dryRun-failed / never submitted
  status: "success" | "failure" | "skipped";  // skipped = before resumeFrom
  employees: string[];
  paidAtPeriod: bigint | null;    // current_period at confirm time — for audit/reconciliation
  gasUsed: bigint | null;
  error: string | null;
}

interface PaydayResult {
  receipts: ChunkReceipt[];       // one per chunk incl. skipped; aligned to plan.chunks
  completed: boolean;             // all chunks success
  nextResumeFrom: number | null;  // where it stopped → feed back to opts.resumeFrom
}
```

The caller serializes `PaydayResult` (file/DB/job row), and on the next run passes
`resumeFrom = result.nextResumeFrom`. **The executor holds no state** — that is the journal seam.

## Sponsored upgrade (deferred, recorded so the seam stays non-breaking)

- Swap the signing seam: sponsored flow (sponsor signs `gasData`, employer signs as sender).
  H3 relaxes from "signer == gas owner" to "sender == cap owner; gas owner == platform sponsor".
- `signer: Signer` becomes `signers: { sender: Signer; sponsor?: Signer }` — **non-breaking**
  (sponsor optional, defaults to current employer-pays behavior).
- H2b gas-coin re-fetch target moves from the employer coin to the sponsor's gas pool.

## Testing (§4) — Rule 9: tests encode WHY

Inject a mock `PaydayClient`; no real chain. Record call order for ordering assertions.

| Class | What it encodes |
|---|---|
| Happy | 3 chunks all succeed → receipts all success, `completed=true`, digests in order |
| **H2 ordering** | chunk[i+1] send happens **after** chunk[i] `waitForConfirm` resolves (mock records call sequence) — the defense against `EAlreadyPaidThisPeriod` |
| **Fail-stop** | chunk[1] effects=failure → chunk[2] never submitted, `nextResumeFrom=1`, fail loud |
| **Resume** | `resumeFrom=2` → chunk[0..1]=skipped and begin_period NOT re-run, not submitted; only chunk[2] sent |
| **Double-pay gate** | `resumeFrom=0` but `currentPeriod === expectedPeriod` (begin_period already ran) → throws, zero submissions |
| Preflight | dryRun fails → zero `signAndExecute`, zero money moved |
| **Monkey / red-team** | resumeFrom out of range (>N, negative); expectedPeriod off by ≥1 from chain; empty plan; `waitForConfirm` timeout/throw mid-run; chunk[0] dryRun passes but real submit aborts |

## Files

```
ts/src/payday/
  execute.ts        // executePayday() + assertPeriodGate()
  execute-types.ts  // PaydayClient, ChunkReceipt, PaydayResult, DryRunResult, ExecResult
ts/test/payday/
  execute.test.ts
```

No changes to Phase A files (`build.ts`/`chunk.ts`/`types.ts`) or any `.move` source.
