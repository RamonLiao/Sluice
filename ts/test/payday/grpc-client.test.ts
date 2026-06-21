import { describe, it, expect, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { GrpcPaydayClient, type CoreLike, type SignerLike } from "../../src/payday/grpc-client.js";
import { PAYROLL_BCS } from "../../src/payday/grpc-helpers.js";

const addr = normalizeSuiAddress("0x1");
const periodBytes = (p: string) =>
  PAYROLL_BCS.serialize({ id: addr, version: "1", owner_cap_id: addr, escrow_id: addr, funding: "0", employees: { id: addr, size: "0" }, current_period: p }).toBytes();

function fakeCore(over: Partial<CoreLike> = {}): CoreLike {
  return {
    getObject: vi.fn(async () => ({ object: { content: Promise.resolve(periodBytes("7")) } })),
    dryRunTransaction: vi.fn(async () => ({ transaction: { effects: { status: { success: true, error: null } } } })),
    executeTransaction: vi.fn(async () => ({ transaction: { digest: "0xok", effects: { status: { success: true, error: null }, gasUsed: { computationCost: "5", storageCost: "0", storageRebate: "0" } } } })),
    waitForTransaction: vi.fn(async () => ({})),
    ...over,
  };
}
const signer: SignerLike = { toSuiAddress: () => addr, signTransaction: vi.fn(async () => ({ signature: "sig" })) };

function stubBuild(tx: Transaction) { vi.spyOn(tx, "build").mockResolvedValue(new Uint8Array([1, 2, 3])); return tx; }

describe("GrpcPaydayClient", () => {
  it("getCurrentPeriod decodes the on-chain struct to bigint", async () => {
    const c = new GrpcPaydayClient(fakeCore());
    expect(await c.getCurrentPeriod("0xpayroll")).toBe(7n);
  });

  it("signAndExecute builds, signs, executes, returns mapped success result", async () => {
    const core = fakeCore();
    const c = new GrpcPaydayClient(core);
    const res = await c.signAndExecute(stubBuild(new Transaction()), signer);
    expect(res).toEqual({ kind: "success", digest: "0xok", error: null, gasUsed: 5n });
    expect(core.executeTransaction).toHaveBeenCalledWith({ transaction: new Uint8Array([1, 2, 3]), signatures: ["sig"] });
  });

  it("signAndExecute maps a Move abort to the FailedTransaction sentinel", async () => {
    const core = fakeCore({
      executeTransaction: vi.fn(async () => ({ transaction: { digest: "0xbad", effects: { status: { success: false, error: "MoveAbort 12" }, gasUsed: { computationCost: "3", storageCost: "0", storageRebate: "0" } } } })),
    });
    const res = await new GrpcPaydayClient(core).signAndExecute(stubBuild(new Transaction()), signer);
    expect(res.kind).toBe("FailedTransaction");
    expect(res.error).toBe("MoveAbort 12");
    expect(res.gasUsed).toBe(3n);
  });

  it("dryRunTransaction surfaces abort as ok:false", async () => {
    const core = fakeCore({ dryRunTransaction: vi.fn(async () => ({ transaction: { effects: { status: { success: false, error: "EInsufficientFunding" } } } })) });
    expect(await new GrpcPaydayClient(core).dryRunTransaction(stubBuild(new Transaction()))).toEqual({ ok: false, error: "EInsufficientFunding" });
  });

  it("waitForConfirm resolves for a finalized-with-abort digest (does not inspect status)", async () => {
    const core = fakeCore({ waitForTransaction: vi.fn(async () => ({ transaction: { effects: { status: { success: false, error: "x" } } } })) });
    await expect(new GrpcPaydayClient(core).waitForConfirm("0xany")).resolves.toBeUndefined();
  });

  it("waitForConfirm rethrows a timeout loudly", async () => {
    const core = fakeCore({ waitForTransaction: vi.fn(async () => { throw new Error("timeout"); }) });
    await expect(new GrpcPaydayClient(core).waitForConfirm("0xnever")).rejects.toThrow("timeout");
  });
});
