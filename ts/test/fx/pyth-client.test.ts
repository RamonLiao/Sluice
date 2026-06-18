import { describe, it, expect } from "vitest";
import { getFxScalars } from "../../src/fx/pyth-client.js";
import { UnknownFxPair, FxFeedUnavailable, type RawPythPrice } from "../../src/fx/types.js";

const enc = (s: string) => new TextEncoder().encode(s);
const raw = (price: bigint, sec: bigint, expo = -8): RawPythPrice => ({ price, expo, publishTimeSec: sec });

describe("getFxScalars", () => {
  // WHY: the three scalars must align byte-for-byte / scale-for-scale with the pay_one seam.
  it("direct pair: D9 rate, ms time, UTF-8 label", async () => {
    const fake = async (_id: string) => raw(108_500_000n, 1_700_000_000n); // 1.085 @ expo -8
    const r = await getFxScalars("EUR/USD", fake);
    expect(r.fx_rate).toBe(1_085_000_000n);
    expect(r.fx_pyth_publish_time_ms).toBe(1_700_000_000_000n);
    expect(r.fx_pair).toEqual(enc("EUR/USD"));
  });

  it("inverse pair JPY/USD: reciprocal of USD/JPY, publish time passes through", async () => {
    // USD/JPY 156.25 @ expo -8 -> price 15_625_000_000 -> D9 156_250_000_000 -> 1/x = 6_400_000
    const fake = async (_id: string) => raw(15_625_000_000n, 1_699_000_000n);
    const r = await getFxScalars("JPY/USD", fake);
    expect(r.fx_rate).toBe(6_400_000n);
    expect(r.fx_pyth_publish_time_ms).toBe(1_699_000_000_000n);
    expect(r.fx_pair).toEqual(enc("JPY/USD"));
  });

  it("unknown pair throws UnknownFxPair", async () => {
    // @ts-expect-error intentionally invalid pair
    await expect(getFxScalars("XXX/USD", async () => raw(1n, 1n))).rejects.toThrow(UnknownFxPair);
  });

  it("propagates FxFeedUnavailable from fetcher", async () => {
    const fake = async () => { throw new FxFeedUnavailable("down"); };
    await expect(getFxScalars("EUR/USD", fake)).rejects.toThrow(FxFeedUnavailable);
  });
});
