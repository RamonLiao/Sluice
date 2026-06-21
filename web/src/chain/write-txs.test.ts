import { describe, it, expect } from "vitest";
import { pickCreatedObjects } from "./write-txs.js";

describe("pickCreatedObjects", () => {
  it("identifies the 3 created objects by objectType, ignoring array order", () => {
    const changes = [
      { type: "created", objectType: `0xpkg::payroll::PayrollOwnerCap`, objectId: "0xcap" },
      { type: "created", objectType: `0xpkg::escrow::TaxEscrow<0x2::sui::SUI>`, objectId: "0xesc" },
      { type: "created", objectType: `0xpkg::payroll::Payroll<0x2::sui::SUI>`, objectId: "0xpay" },
    ];
    expect(pickCreatedObjects(changes as any)).toEqual({
      payrollId: "0xpay", ownerCapId: "0xcap", escrowId: "0xesc",
    });
  });
});
