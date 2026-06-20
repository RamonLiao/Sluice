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
