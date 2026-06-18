import { InvalidFxPrice, FxRateOverflow, type RawPythPrice } from "./types.js";

const U64_MAX = 2n ** 64n - 1n;

/** D9 fixed-point: round(price × 10^(expo+9)). bigint-only, round-half-up on division. */
export function rawToFxRate(raw: RawPythPrice): bigint {
  if (raw.price <= 0n) throw new InvalidFxPrice(`price must be > 0, got ${raw.price}`);
  const shift = raw.expo + 9;
  let rate: bigint;
  if (shift >= 0) {
    rate = raw.price * 10n ** BigInt(shift);
  } else {
    const div = 10n ** BigInt(-shift);
    rate = (raw.price + div / 2n) / div; // round-half-up (price > 0)
  }
  if (rate <= 0n || rate > U64_MAX) throw new FxRateOverflow(`fx_rate out of u64 range: ${rate}`);
  return rate;
}

/** Pyth publish_time is SECONDS; the seam wants milliseconds. */
export function secToMs(sec: bigint): bigint {
  return sec * 1000n;
}
