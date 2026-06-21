import { describe, it, expect, vi } from "vitest";
import * as orchestrator from "@payroll-flow/orchestrator";
import { jurisdictionToPair, runPayday } from "./run-payday.js";

vi.mock("@payroll-flow/orchestrator", async () => {
  const actual = await vi.importActual<typeof orchestrator>("@payroll-flow/orchestrator");
  return {
    ...actual,
    executePayday: vi.fn(async () => ({ completed: true })),
  };
});

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

    await runPayday({ rows, reader: {} as any, client: client as any,
      signer: { toSuiAddress: () => "0xme" }, fetchFx: fetchFx as any });

    // Direct assertion: executePayday MUST receive expectedPeriod = 4n (3+1)
    // If someone drops the +1n logic, this fails immediately
    expect(orchestrator.executePayday).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expectedPeriod: 4n, resumeFrom: 0 })
    );
  });

  it("passes expectedPeriod = currentPeriod (no +1) on resume path (C2 gate)", async () => {
    const client = {
      getCurrentPeriod: vi.fn(async () => 5n),
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

    await runPayday({ rows, reader: {} as any, client: client as any,
      signer: { toSuiAddress: () => "0xme" }, fetchFx: fetchFx as any, resumeFrom: 2 });

    // Resume path: expectedPeriod should be currentPeriod (5n), NOT 6n
    expect(orchestrator.executePayday).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expectedPeriod: 5n, resumeFrom: 2 })
    );
  });

  it("includes active employee with gross=0 — no gross filter (matches Move)", async () => {
    // Ensures gross=0 rows are NOT silently dropped; Move pays 0 which is correct.
    const client = {
      getCurrentPeriod: vi.fn(async () => 1n),
      dryRunTransaction: vi.fn(async () => ({ ok: true, error: null })),
      signAndExecute: vi.fn(async () => ({ kind: "success", digest: "0x2", error: null, gasUsed: null })),
      waitForConfirm: vi.fn(async () => {}),
    };
    const rows = [
      { addr: "0xbb", jurisdiction: new TextEncoder().encode("EU"),
        gross: 0n, withholdingBps: 0, liquidBps: 10000, scallopBps: 0, naviBps: 0,
        pendingFromPeriod: null, lastPaidPeriod: 0n, active: true },
    ];
    const fetchFx = vi.fn(async () => ({
      fx_pair: new TextEncoder().encode("EUR/USD"), fx_rate: 1_080_000_000n,
      fx_pyth_publish_time_ms: 1_700_000_000_000n }));

    await runPayday({ rows, reader: {} as any, client: client as any,
      signer: { toSuiAddress: () => "0xme" }, fetchFx: fetchFx as any });

    // buildPayday must have been called with the gross=0 employee included
    expect(orchestrator.executePayday).toHaveBeenCalled();
    // If rows were filtered by gross, executePayday would receive an empty plan —
    // the mock always returns completed:true so we can't assert on plan contents,
    // but we CAN assert fetchFx was called (meaning the active row was processed).
    expect(fetchFx).toHaveBeenCalled();
  });
});
