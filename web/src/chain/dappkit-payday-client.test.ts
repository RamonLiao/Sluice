import { describe, it, expect, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { DappKitPaydayClient } from "./dappkit-payday-client.js";

describe("DappKitPaydayClient", () => {
  it("signAndExecute delegates to the injected wallet fn with the raw Transaction (no pre-build)", async () => {
    const tx = new Transaction();
    const buildSpy = vi.spyOn(tx, "build");
    const signAndExecuteFn = vi.fn(async (t: Transaction) => {
      expect(t).toBe(tx);            // same Transaction object handed to the wallet
      return { digest: "0xdig" };
    });
    const client = new DappKitPaydayClient({} as any, signAndExecuteFn);
    const res = await client.signAndExecute(tx, { toSuiAddress: () => "0xme" });
    expect(res.kind).toBe("success");
    expect(res.digest).toBe("0xdig");
    expect(buildSpy).not.toHaveBeenCalled(); // adapter never builds; wallet does — preserves per-chunk resolve
  });

  it("getCurrentPeriod reads current_period as bigint", async () => {
    const suiClient = { getObject: vi.fn(async () => ({
      data: { content: { fields: { current_period: "7" } } } })) };
    const client = new DappKitPaydayClient(suiClient as any, vi.fn());
    expect(await client.getCurrentPeriod("0xpay")).toBe(7n);
  });
});
