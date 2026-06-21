import { describe, it, expect, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { GrpcPaydayClient, makeGrpcPaydayClient, type CoreLike, type SignerLike } from "../../src/payday/grpc-client.js";
import { PAYROLL_BCS } from "../../src/payday/grpc-helpers.js";

const addr = normalizeSuiAddress("0x1");
const periodBytes = (p: string) =>
  PAYROLL_BCS.serialize({ id: addr, version: "1", owner_cap_id: addr, escrow_id: addr, funding: "0", employees: { id: addr, size: "0" }, current_period: p }).toBytes();

// Stubs model the REAL @mysten/sui@2.x core shapes (verified against client/types.d.mts):
//   getObject → { object: { content: Uint8Array } } (RAW BCS, NOT a Promise)
//   simulate/execute → { Transaction: { digest, status, effects: { status, gasUsed } } }
//   status.error is the structured ExecutionError object { message }, flattened to a string by the adapter.
function fakeCore(over: Partial<CoreLike> = {}): CoreLike {
  return {
    getObject: vi.fn(async () => ({ object: { content: periodBytes("7") } })),
    simulateTransaction: vi.fn(async () => ({ Transaction: { digest: "0xsim", status: { success: true, error: null }, effects: { status: { success: true, error: null } } } })),
    executeTransaction: vi.fn(async () => ({ Transaction: { digest: "0xok", status: { success: true, error: null }, effects: { status: { success: true, error: null }, gasUsed: { computationCost: "5", storageCost: "0", storageRebate: "0" } } } })),
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
    expect(core.executeTransaction).toHaveBeenCalledWith({ transaction: new Uint8Array([1, 2, 3]), signatures: ["sig"], include: { effects: true } });
  });

  it("signAndExecute maps a Move abort to the FailedTransaction sentinel", async () => {
    const core = fakeCore({
      // v2 FailedTransaction member + structured ExecutionError { message }; adapter flattens to the string.
      executeTransaction: vi.fn(async () => ({ FailedTransaction: { digest: "0xbad", status: { success: false as const, error: { message: "MoveAbort 12" } }, effects: { status: { success: false as const, error: { message: "MoveAbort 12" } }, gasUsed: { computationCost: "3", storageCost: "0", storageRebate: "0" } } } })),
    });
    const res = await new GrpcPaydayClient(core).signAndExecute(stubBuild(new Transaction()), signer);
    expect(res.kind).toBe("FailedTransaction");
    expect(res.error).toBe("MoveAbort 12");
    expect(res.gasUsed).toBe(3n);
  });

  it("dryRunTransaction surfaces abort as ok:false", async () => {
    const core = fakeCore({ simulateTransaction: vi.fn(async () => ({ FailedTransaction: { digest: "0xsim", status: { success: false as const, error: { message: "EInsufficientFunding" } }, effects: { status: { success: false as const, error: { message: "EInsufficientFunding" } } } } })) });
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

describe("makeGrpcPaydayClient factory wiring smoke test", () => {
  // A mock mirroring the REAL @mysten/sui@2.x rpc.core surface. The point of this test is to FAIL if
  // the adapter calls a core method with the wrong param shape or off the wrong client. typeof-function
  // checks (the prior version) could not catch that — those wrappers are class methods, always functions
  // even when the underlying rpc.core.getObject is undefined or expects different params. Here we drive
  // EVERY adapter method end-to-end against the mock and assert each invoked the right core method with
  // the exact v2 param shape (objectId+include / transaction+include / signatures / digest+timeout).
  function realShapedCore() {
    return {
      getObject: vi.fn(async () => ({ object: { content: periodBytes("9") } })),
      simulateTransaction: vi.fn(async () => ({ Transaction: { digest: "0xs", status: { success: true, error: null }, effects: { status: { success: true, error: null } } } })),
      executeTransaction: vi.fn(async () => ({ Transaction: { digest: "0xe", status: { success: true, error: null }, effects: { status: { success: true, error: null }, gasUsed: { computationCost: "1", storageCost: "0", storageRebate: "0" } } } })),
      waitForTransaction: vi.fn(async () => ({ Transaction: { digest: "0xw", status: { success: true, error: null } } })),
    };
  }

  it("sources every method off rpc.core with the exact v2 param shapes (catches the old dead-shape wiring)", async () => {
    const core = realShapedCore();
    // Factory injects this core; public signature stays (opts) → GrpcPaydayClient.
    const client = makeGrpcPaydayClient({ network: "testnet" }, core as unknown as CoreLike);

    expect(await client.getCurrentPeriod("0xpayroll")).toBe(9n);
    expect(core.getObject).toHaveBeenCalledWith({ objectId: "0xpayroll", include: { content: true } });

    await client.dryRunTransaction(stubBuild(new Transaction()));
    expect(core.simulateTransaction).toHaveBeenCalledWith({ transaction: new Uint8Array([1, 2, 3]), include: { effects: true } });

    await client.signAndExecute(stubBuild(new Transaction()), signer);
    expect(core.executeTransaction).toHaveBeenCalledWith({ transaction: new Uint8Array([1, 2, 3]), signatures: ["sig"], include: { effects: true } });

    await client.waitForConfirm("0xdigest");
    expect(core.waitForTransaction).toHaveBeenCalledWith({ digest: "0xdigest", timeout: 60_000 });
  });
});
