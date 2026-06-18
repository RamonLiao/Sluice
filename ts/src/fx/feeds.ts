import type { FxPair } from "./types.js";

export type FeedSpec =
  | { kind: "direct"; id: string }
  | { kind: "inverse"; id: string };           // pair = 1 / (feed), single-feed reciprocal

// Feed ids resolved from the Pyth Hermes registry (asset_type=fx, 2026-06-18).
// Do NOT invent ids. JPY/USD has no direct Pyth feed — only USD/JPY exists — so it
// is derived as the reciprocal of USD/JPY. EUR/GBP has a direct feed (no cross needed).
export const FEEDS: Record<FxPair, FeedSpec> = {
  "EUR/USD": { kind: "direct", id: "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b" },
  "GBP/USD": { kind: "direct", id: "0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1" },
  // JPY/USD = 1 / (USD/JPY); USD/JPY feed id below.
  "JPY/USD": { kind: "inverse", id: "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52" },
  "EUR/GBP": { kind: "direct", id: "0xc349ff6087acab1c0c5442a9de0ea804239cc9fd09be8b1a93ffa0ed7f366d9c" },
};
