import { describe, it, expect } from "vitest";
import { decodeEmployeeField } from "./payroll-reader.js";
import fixture from "./__fixtures__/employee-field.json";

describe("decodeEmployeeField", () => {
  it("decodes nested Field<addr,EmployeeRecord> into EmployeeRow with bigint u64", () => {
    const row = decodeEmployeeField(fixture as any);
    expect(typeof row.gross).toBe("bigint");
    expect(row.gross).toBe(1000n);
    expect(typeof row.lastPaidPeriod).toBe("bigint");
    expect(row.lastPaidPeriod).toBe(3n);
    expect(row.liquidBps + row.scallopBps + row.naviBps).toBe(10000);
    expect(row.addr).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row.withholdingBps).toBeTypeOf("number");
    expect(row.withholdingBps).toBe(1000);
    expect(row.jurisdiction).toBeInstanceOf(Uint8Array);
    expect(Array.from(row.jurisdiction)).toEqual([85, 83]);
    expect(row.pendingFromPeriod).toBeNull();
    expect(row.active).toBe(true);
  });
});
