import type { Transaction } from "@mysten/sui/transactions";
import type { PaydayPlan } from "./types.js";
import {
  PeriodGateError,
  type PaydayClient,
  type PaydaySigner,
  type PaydayResult,
  type ChunkReceipt,
  type ExecutePaydayOpts,
  ResumeRangeError,
} from "./execute-types.js";

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
