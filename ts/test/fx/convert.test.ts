import { describe, it, expect } from "vitest";
import { rawToFxRate, secToMs, deriveInverse } from "../../src/fx/convert.js";
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

describe("deriveInverse (JPY/USD = 1 / USD/JPY)", () => {
  // WHY: Pyth has no JPY/USD feed, only USD/JPY. The reciprocal must stay D9-scaled
  // so the tiny ~0.0064 rate keeps 9 fractional digits of precision for auditors.
  it("inverts a D9 rate back into D9", () => {
    // USD/JPY 156.25 (156_250_000_000) -> 1/156.25 = 0.0064 -> 6_400_000
    expect(deriveInverse(156_250_000_000n)).toBe(6_400_000n);
  });
  it("round-half-up on inversion", () => {
    // USD/JPY 3.0 (3_000_000_000) -> 1/3 = 0.333333333... -> 333_333_333 (…3.3 rounds down)
    expect(deriveInverse(3_000_000_000n)).toBe(333_333_333n);
  });
  it("rejects denominator <= 0", () => {
    expect(() => deriveInverse(0n)).toThrow(InvalidFxPrice);
    expect(() => deriveInverse(-1n)).toThrow(InvalidFxPrice);
  });
  // NOTE: overflow is unreachable for inverse — numerator is fixed at 1e18, so any
  // den>=1 yields <=1e18, well under u64::MAX (~1.84e19). The guard stays as defense.
});

describe("secToMs", () => {
  // WHY: Pyth publish_time is seconds; the seam compares against clock.timestamp_ms().
  // Passing seconds into a ms field reads as ~50 years stale -> fx_stale always true.
  it("multiplies seconds by 1000", () => {
    expect(secToMs(1_700_000_000n)).toBe(1_700_000_000_000n);
  });
});
