export type FxPair = "EUR/USD" | "GBP/USD" | "JPY/USD" | "EUR/GBP";

/** Normalized Pyth price, SDK-independent. The Hermes adapter produces this. */
export interface RawPythPrice {
  price: bigint;          // signed integer mantissa
  expo: number;           // power-of-ten exponent (typically negative, e.g. -8)
  publishTimeSec: bigint; // Pyth native publish time, SECONDS
}

/** The exact scalars the on-chain `pay_one` seam consumes. */
export interface FxScalars {
  fx_pair: Uint8Array;             // UTF-8 of the canonical BASE/QUOTE label
  fx_rate: bigint;                 // D9 fixed-point, must fit u64
  fx_pyth_publish_time_ms: bigint; // u64, milliseconds
}

export class InvalidFxPrice extends Error {}    // price <= 0 (incl. inverse/cross denominator)
export class FxRateOverflow extends Error {}    // fx_rate <= 0 or > u64::MAX
export class UnknownFxPair extends Error {}     // pair not in FEEDS
export class FxFeedUnavailable extends Error {} // Hermes returned nothing for a feed id
