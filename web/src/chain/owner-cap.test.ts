import { describe, it, expect } from "vitest";
import { matchOwnerCap } from "./owner-cap.js";

describe("matchOwnerCap", () => {
  const expected = "0xabc"; const payrollId = "0xpay";
  it("accepts a cap matching both payroll_id and object id", () => {
    const cap = { data: { objectId: "0xabc", content: { fields: { payroll_id: "0xpay" } } } };
    expect(matchOwnerCap(cap as any, payrollId, expected)).toBe(true);
  });
  it("rejects a cap for a different payroll (would abort on-chain)", () => {
    const cap = { data: { objectId: "0xabc", content: { fields: { payroll_id: "0xother" } } } };
    expect(matchOwnerCap(cap as any, payrollId, expected)).toBe(false);
  });
  it("rejects a cap whose object id != Payroll.owner_cap_id", () => {
    const cap = { data: { objectId: "0xdead", content: { fields: { payroll_id: "0xpay" } } } };
    expect(matchOwnerCap(cap as any, payrollId, expected)).toBe(false);
  });
});
