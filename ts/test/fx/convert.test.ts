import { describe, it, expect } from "vitest";
import { rawToFxRate, secToMs } from "../../src/fx/convert.js";
import { InvalidFxPrice, FxRateOverflow } from "../../src/fx/types.js";

const U64_MAX = 2n ** 64n - 1n;

describe("rawToFxRate (D9 fixed point)", () => {
  // WHY: wrong scale silently corrupts the local-currency value logged for auditors.
  it("expo -8: multiply by 10^(expo+9)=10^1", () => {
    // price 108_500_000 @ expo -8 = 1.085 EUR/USD -> D9 = 1_085_000_000
    expect(rawToFxRate({ price: 108_500_000n, expo: -8, publishTimeSec: 0n })).toBe(1_085_000_000n);
  });
  it("expo -9: factor 10^0 = identity", () => {
    expect(rawToFxRate({ price: 1_085_000_000n, expo: -9, publishTimeSec: 0n })).toBe(1_085_000_000n);
  });
  it("expo -10: factor 10^-1, round-half-up", () => {
    // 1_085_000_005 / 10 = 108_500_000.5 -> round up 108_500_001
    expect(rawToFxRate({ price: 1_085_000_005n, expo: -10, publishTimeSec: 0n })).toBe(108_500_001n);
  });
  it("JPY/USD tiny rate stays precise at D9", () => {
    // 0.0064 @ expo -8 -> price 640_000 ; ×10 = 6_400_000
    expect(rawToFxRate({ price: 640_000n, expo: -8, publishTimeSec: 0n })).toBe(6_400_000n);
  });
  it("rejects price <= 0", () => {
    expect(() => rawToFxRate({ price: 0n, expo: -8, publishTimeSec: 0n })).toThrow(InvalidFxPrice);
    expect(() => rawToFxRate({ price: -1n, expo: -8, publishTimeSec: 0n })).toThrow(InvalidFxPrice);
  });
  it("rejects fx_rate > u64::MAX", () => {
    expect(() => rawToFxRate({ price: U64_MAX, expo: 0, publishTimeSec: 0n })).toThrow(FxRateOverflow);
  });
});

describe("secToMs", () => {
  // WHY: Pyth publish_time is seconds; the seam compares against clock.timestamp_ms().
  // Passing seconds into a ms field reads as ~50 years stale -> fx_stale always true.
  it("multiplies seconds by 1000", () => {
    expect(secToMs(1_700_000_000n)).toBe(1_700_000_000_000n);
  });
});
