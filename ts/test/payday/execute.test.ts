import { describe, it, expect } from "vitest";
import { assertPeriodGate } from "../../src/payday/execute.js";
import { PeriodGateError } from "../../src/payday/execute-types.js";

describe("assertPeriodGate", () => {
  it("no expectedPeriod => no gate (demo mode)", () => {
    expect(() => assertPeriodGate(5n, 0)).not.toThrow();
    expect(() => assertPeriodGate(5n, 3)).not.toThrow();
  });

  it("fresh run requires current_period === expectedPeriod - 1 (begin_period will advance it)", () => {
    expect(() => assertPeriodGate(0n, 0, 1n)).not.toThrow(); // chain at 0, paying period 1
  });

  it("fresh run throws if begin_period already ran (double-pay risk)", () => {
    // chain already at 1 but caller thinks this is a fresh payday for period 1:
    // re-running begin_period would open period 2 and re-pay everyone -> reject.
    expect(() => assertPeriodGate(1n, 0, 1n)).toThrow(PeriodGateError);
  });

  it("resume requires current_period === expectedPeriod (begin_period already landed)", () => {
    expect(() => assertPeriodGate(1n, 2, 1n)).not.toThrow();
    expect(() => assertPeriodGate(0n, 2, 1n)).toThrow(PeriodGateError); // period not advanced -> drift
    expect(() => assertPeriodGate(2n, 2, 1n)).toThrow(PeriodGateError); // advanced too far -> drift
  });
});
