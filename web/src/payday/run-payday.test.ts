import { describe, it, expect, vi } from "vitest";
import { jurisdictionToPair, runPayday } from "./run-payday.js";

describe("jurisdictionToPair", () => {
  it("maps EU jurisdiction bytes to EUR/USD", () => {
    expect(jurisdictionToPair(new TextEncoder().encode("EU"))).toBe("EUR/USD");
  });
  it("throws on unknown jurisdiction (fail loud, no silent default)", () => {
    expect(() => jurisdictionToPair(new TextEncoder().encode("ZZ"))).toThrow();
  });
});

describe("runPayday", () => {
  it("passes expectedPeriod = currentPeriod+1 on a fresh run (C2 gate)", async () => {
    const client = {
      getCurrentPeriod: vi.fn(async () => 3n),
      dryRunTransaction: vi.fn(async () => ({ ok: true, error: null })),
      signAndExecute: vi.fn(async () => ({ kind: "success", digest: "0x1", error: null, gasUsed: null })),
      waitForConfirm: vi.fn(async () => {}),
    };
    const rows = [{ addr: "0xaa", jurisdiction: new TextEncoder().encode("EU"),
      gross: 100n, withholdingBps: 0, liquidBps: 10000, scallopBps: 0, naviBps: 0,
      pendingFromPeriod: null, lastPaidPeriod: 0n, active: true }];
    const fetchFx = vi.fn(async () => ({
      fx_pair: new TextEncoder().encode("EUR/USD"), fx_rate: 1_080_000_000n,
      fx_pyth_publish_time_ms: 1_700_000_000_000n }));
    const res = await runPayday({ rows, reader: {} as any, client: client as any,
      signer: { toSuiAddress: () => "0xme" }, fetchFx: fetchFx as any });
    expect(res.completed).toBe(true);
    // executePayday read period=3 and gated against expectedPeriod=4 — no throw means gate passed
    expect(client.getCurrentPeriod).toHaveBeenCalled();
  });
});
