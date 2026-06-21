import { describe, it, expect } from "vitest";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { computeNetGas, mapExecResult, mapDryRun, decodeCurrentPeriod, PAYROLL_BCS } from "../../src/payday/grpc-helpers.js";

const gas = (c: string, s: string, r: string) => ({
  computationCost: c, storageCost: s, storageRebate: r, nonRefundableStorageFee: "0",
});

describe("computeNetGas", () => {
  it("nets rebate out of computation + storage", () => {
    expect(computeNetGas(gas("1000", "500", "200"))).toBe(1300n);
  });
  it("handles full rebate", () => {
    expect(computeNetGas(gas("1000", "500", "1500"))).toBe(0n);
  });
});

describe("mapExecResult", () => {
  it("maps success", () => {
    const res = { transaction: { digest: "0xabc", effects: { status: { success: true, error: null }, gasUsed: gas("10", "0", "0") } } };
    expect(mapExecResult(res)).toEqual({ kind: "success", digest: "0xabc", error: null, gasUsed: 10n });
  });
  it("maps abort to the port sentinel 'FailedTransaction' with gas captured", () => {
    const res = { transaction: { digest: "0xdef", effects: { status: { success: false, error: "MoveAbort 11" }, gasUsed: gas("7", "0", "0") } } };
    expect(mapExecResult(res)).toEqual({ kind: "FailedTransaction", digest: "0xdef", error: "MoveAbort 11", gasUsed: 7n });
  });
});

describe("mapDryRun", () => {
  it("ok on success", () => {
    expect(mapDryRun({ transaction: { effects: { status: { success: true, error: null } } } })).toEqual({ ok: true, error: null });
  });
  it("not-ok surfaces the abort string", () => {
    expect(mapDryRun({ transaction: { effects: { status: { success: false, error: "EInsufficientFunding" } } } })).toEqual({ ok: false, error: "EInsufficientFunding" });
  });
});

describe("decodeCurrentPeriod", () => {
  it("decodes current_period as bigint from a full Payroll<T> struct (layout pin)", () => {
    const addr = normalizeSuiAddress("0x1");
    const bytes = PAYROLL_BCS.serialize({
      id: addr, version: "1", owner_cap_id: addr, escrow_id: addr,
      funding: "0", employees: { id: addr, size: "0" }, current_period: "42",
    }).toBytes();
    expect(decodeCurrentPeriod(bytes)).toBe(42n);
  });
});
