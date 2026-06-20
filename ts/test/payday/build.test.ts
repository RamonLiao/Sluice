import { describe, it, expect } from "vitest";
import { assertPaydayInputs } from "../../src/payday/build.js";
import { DuplicatePayee, MissingFxScalars, FxPairLabelMismatch } from "../../src/payday/types.js";
import type { FxScalars } from "../../src/fx/types.js";

const scalars = (pair: string): FxScalars => ({
  fx_pair: new TextEncoder().encode(pair),
  fx_rate: 1_085_000_000n,
  fx_pyth_publish_time_ms: 1_700_000_000_000n,
});
const fxMap = new Map<string, FxScalars>([["EUR/USD", scalars("EUR/USD")]]);

describe("assertPaydayInputs", () => {
  // WHY: silently skipping or mislabeling a payee corrupts the on-chain compliance event
  // the auditor relies on — the operator invariant from move-notes open-task #4.
  it("accepts well-formed inputs", () => {
    expect(() => assertPaydayInputs([{ addr: "0x1", pair: "EUR/USD" }], fxMap)).not.toThrow();
  });
  it("rejects duplicate payee address (would abort whole PTB on-chain)", () => {
    expect(() =>
      assertPaydayInputs(
        [{ addr: "0x1", pair: "EUR/USD" }, { addr: "0x1", pair: "EUR/USD" }],
        fxMap,
      ),
    ).toThrow(DuplicatePayee);
  });
  it("rejects employee whose pair has no scalars (never skip a payee)", () => {
    expect(() => assertPaydayInputs([{ addr: "0x1", pair: "GBP/USD" }], fxMap)).toThrow(MissingFxScalars);
  });
  it("rejects scalars whose fx_pair bytes mismatch the employee pair", () => {
    const bad = new Map<string, FxScalars>([["EUR/USD", scalars("GBP/USD")]]);
    expect(() => assertPaydayInputs([{ addr: "0x1", pair: "EUR/USD" }], bad)).toThrow(FxPairLabelMismatch);
  });
});
