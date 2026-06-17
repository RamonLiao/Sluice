# Pyth FX Off-chain (Opt 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested off-chain TypeScript Pyth FX client that converts Hermes price feeds into the exact `(fx_pair, fx_rate, fx_pyth_publish_time_ms)` scalars the on-chain `pay_one` seam expects.

**Architecture:** Pure-conversion core (SDK-independent, fully unit-tested) sits behind a thin Hermes IO adapter. The conversion layer enforces the D9 fixed-point scale and the seconds→ms unit contract. No Move source changes — the seam already exists. EUR/GBP is handled as either a direct feed or a cross-derivation depending on Pyth registry availability (resolved in Task 1).

**Tech Stack:** pnpm, TypeScript (strict), vitest, `@pythnetwork/hermes-client` (Hermes pull, adapter only). `bigint` end-to-end for u64 fidelity.

**Spec:** `docs/superpowers/specs/2026-06-17-pyth-fx-offchain-design.md`

---

## File Structure

```
ts/
  package.json            # pnpm workspace root for orchestrator; deps + scripts
  tsconfig.json           # strict
  vitest.config.ts
  src/
    fx/
      types.ts            # FxPair, FxScalars, RawPythPrice, typed errors
      feeds.ts            # FEEDS: Record<FxPair, FeedSpec> (direct | cross)
      convert.ts          # PURE: rawToFxRate, secToMs, deriveCross — no IO
      hermes.ts           # IO adapter: feedId -> RawPythPrice (thin, wraps SDK)
      pyth-client.ts      # getFxScalars(pair): orchestrates feeds+hermes+convert
  test/
    fx/
      convert.test.ts     # pure conversion unit tests (no network)
      pyth-client.test.ts # getFxScalars with injected fake fetcher
```

**Boundary rule:** `convert.ts` imports nothing from `hermes.ts`. `pyth-client.ts` takes the fetcher as an injectable dependency so tests pass a fake — no live network in any test.

---

## Task 1: Verify Pyth feed registry + scaffold pnpm package

**Files:**
- Create: `ts/package.json`, `ts/tsconfig.json`, `ts/vitest.config.ts`, `ts/.gitignore`

- [ ] **Step 1: Verify feed availability (no code)**

Use `sui-docs-query` or context7, or fetch `https://hermes.pyth.network/v2/price_feeds?asset_type=fx`. Record the hex feed id for each MVP pair:
- EUR/USD, GBP/USD, JPY/USD (expected: direct USD-quoted feeds exist)
- EUR/GBP — **decide**: direct feed exists → `kind: "direct"`; not found → `kind: "cross", num: "EUR/USD", den: "GBP/USD"`.

Write the resolved ids + the EUR/GBP decision into a scratch note for Task 3. **Do not fabricate ids** — if a lookup fails, stop and report.

- [ ] **Step 2: Create `ts/package.json`**

```json
{
  "name": "@payroll-flow/orchestrator",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@pythnetwork/hermes-client": "*"
  },
  "devDependencies": {
    "typescript": "*",
    "vitest": "*"
  }
}
```

Then run `cd ts && pnpm install` and pin `@pythnetwork/hermes-client` / `typescript` / `vitest` to whatever pnpm resolves (replace the `*`). Per dev-rules: read the installed version, do not trust possibly-stale docs.

- [ ] **Step 3: Create `ts/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Create `ts/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

- [ ] **Step 5: Create `ts/.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 6: Commit**

```bash
git add ts/package.json ts/tsconfig.json ts/vitest.config.ts ts/.gitignore ts/pnpm-lock.yaml
git commit -m "chore(ts): #7 scaffold @payroll-flow/orchestrator (pnpm, tsc, vitest)"
```

---

## Task 2: Types + typed errors

**Files:**
- Create: `ts/src/fx/types.ts`

- [ ] **Step 1: Write `ts/src/fx/types.ts`**

```ts
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

export class InvalidFxPrice extends Error {}    // price <= 0 (incl. cross denominator)
export class FxRateOverflow extends Error {}    // fx_rate <= 0 or > u64::MAX
export class UnknownFxPair extends Error {}     // pair not in FEEDS
export class FxFeedUnavailable extends Error {} // Hermes returned nothing for a feed id
```

- [ ] **Step 2: Commit**

```bash
git add ts/src/fx/types.ts
git commit -m "feat(ts): #7 fx types + typed errors"
```

---

## Task 3: FEEDS config

**Files:**
- Create: `ts/src/fx/feeds.ts`
- Test: covered indirectly by Task 5

- [ ] **Step 1: Write `ts/src/fx/feeds.ts`**

Use the ids resolved in Task 1. Direct pairs carry one id; EUR/GBP carries either one id (`direct`) or a numerator/denominator pair (`cross`). Shown here with the cross fallback shape — if Task 1 found a direct EUR/GBP feed, make it `{ kind: "direct", id: "0x..." }` instead.

```ts
import type { FxPair } from "./types.js";

export type FeedSpec =
  | { kind: "direct"; id: string }
  | { kind: "cross"; num: FxPair; den: FxPair };

// Feed ids are hex strings from the Pyth registry — fill from Task 1, do NOT invent.
export const FEEDS: Record<FxPair, FeedSpec> = {
  "EUR/USD": { kind: "direct", id: "0x__EUR_USD__" },
  "GBP/USD": { kind: "direct", id: "0x__GBP_USD__" },
  "JPY/USD": { kind: "direct", id: "0x__JPY_USD__" },
  // If Task 1 found a direct feed, replace with { kind: "direct", id: "0x..." }
  "EUR/GBP": { kind: "cross", num: "EUR/USD", den: "GBP/USD" },
};
```

- [ ] **Step 2: Commit**

```bash
git add ts/src/fx/feeds.ts
git commit -m "feat(ts): #7 FEEDS registry (EUR/GBP/JPY vs USD + EUR/GBP)"
```

---

## Task 4: Pure conversion — `rawToFxRate`, `secToMs` (TDD)

**Files:**
- Create: `ts/src/fx/convert.ts`
- Test: `ts/test/fx/convert.test.ts`

D9 fixed point: `fx_rate = round(price × 10^(expo+9))`. seconds→ms: `× 1000`. u64 max = `2n**64n - 1n`.

- [ ] **Step 1: Write failing tests `ts/test/fx/convert.test.ts`**

```ts
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
```

- [ ] **Step 2: Run, verify fail**

Run: `cd ts && pnpm test convert`
Expected: FAIL — `rawToFxRate`/`secToMs` not exported.

- [ ] **Step 3: Implement `ts/src/fx/convert.ts`**

```ts
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
```

- [ ] **Step 4: Run, verify pass**

Run: `cd ts && pnpm test convert`
Expected: PASS (all convert tests).

- [ ] **Step 5: Commit**

```bash
git add ts/src/fx/convert.ts ts/test/fx/convert.test.ts
git commit -m "feat(ts): #7 D9 fx_rate + sec->ms pure conversion (TDD)"
```

---

## Task 5: Cross-pair derivation `deriveCross` (TDD)

**Files:**
- Modify: `ts/src/fx/convert.ts`
- Modify: `ts/test/fx/convert.test.ts`

EUR/GBP = (EUR/USD) ÷ (GBP/USD), both already as D9 fx_rate bigints. Result must stay D9: `result = round(num_d9 × 1e9 / den_d9)`. publish_time = min of the two.

- [ ] **Step 1: Add failing tests to `ts/test/fx/convert.test.ts`**

```ts
import { deriveCross } from "../../src/fx/convert.js";

describe("deriveCross (EUR/GBP = EUR/USD / GBP/USD)", () => {
  // WHY: a cross rate must remain D9-scaled and inherit the OLDER publish time,
  // so the auditor's staleness signal reflects the weakest leg.
  it("divides two D9 rates back into D9", () => {
    // EUR/USD 1.085 (1_085_000_000), GBP/USD 1.250 (1_250_000_000) -> 0.868 -> 868_000_000
    expect(deriveCross(1_085_000_000n, 1_250_000_000n)).toBe(868_000_000n);
  });
  it("rejects denominator <= 0", () => {
    expect(() => deriveCross(1_085_000_000n, 0n)).toThrow(InvalidFxPrice);
  });
  it("rejects cross result > u64::MAX", () => {
    expect(() => deriveCross(2n ** 64n - 1n, 1n)).toThrow(FxRateOverflow);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd ts && pnpm test convert`
Expected: FAIL — `deriveCross` not exported.

- [ ] **Step 3: Add `deriveCross` to `ts/src/fx/convert.ts`**

```ts
/** Cross rate from two D9 rates, result kept at D9. round-half-up. */
export function deriveCross(numD9: bigint, denD9: bigint): bigint {
  if (denD9 <= 0n) throw new InvalidFxPrice(`cross denominator must be > 0, got ${denD9}`);
  const scaled = numD9 * 1_000_000_000n;
  const rate = (scaled + denD9 / 2n) / denD9; // round-half-up
  if (rate <= 0n || rate > 2n ** 64n - 1n) throw new FxRateOverflow(`cross fx_rate out of u64 range: ${rate}`);
  return rate;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd ts && pnpm test convert`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ts/src/fx/convert.ts ts/test/fx/convert.test.ts
git commit -m "feat(ts): #7 cross-pair derivation (D9, min publish_time) (TDD)"
```

---

## Task 6: Hermes IO adapter

**Files:**
- Create: `ts/src/fx/hermes.ts`

Thin, untested-by-unit (live network). Maps SDK response → `RawPythPrice`. Verify the exact SDK call/shape against the installed `@pythnetwork/hermes-client` version (read node_modules types, per dev-rules — do NOT trust stale docs).

- [ ] **Step 1: Write `ts/src/fx/hermes.ts`**

```ts
import { HermesClient } from "@pythnetwork/hermes-client";
import { FxFeedUnavailable, type RawPythPrice } from "./types.js";

export type FetchRawPrice = (feedId: string) => Promise<RawPythPrice>;

const HERMES_URL = "https://hermes.pyth.network";

/** Live fetcher. Adjust field access to match the installed SDK's response shape. */
export function makeHermesFetcher(client = new HermesClient(HERMES_URL)): FetchRawPrice {
  return async (feedId: string): Promise<RawPythPrice> => {
    const res = await client.getLatestPriceUpdates([feedId]);
    const p = res?.parsed?.[0]?.price;
    if (!p) throw new FxFeedUnavailable(`no Hermes price for feed ${feedId}`);
    return {
      price: BigInt(p.price),
      expo: Number(p.expo),
      publishTimeSec: BigInt(p.publish_time),
    };
  };
}
```

> If the installed SDK exposes a different method/field names, fix them here only — the conversion layer and tests are insulated from this.

- [ ] **Step 2: Build check**

Run: `cd ts && pnpm build`
Expected: PASS (tsc no errors). If SDK field names differ, fix in `hermes.ts` until clean.

- [ ] **Step 3: Commit**

```bash
git add ts/src/fx/hermes.ts
git commit -m "feat(ts): #7 Hermes IO adapter -> RawPythPrice"
```

---

## Task 7: `getFxScalars` orchestration (TDD with injected fetcher)

**Files:**
- Create: `ts/src/fx/pyth-client.ts`
- Test: `ts/test/fx/pyth-client.test.ts`

`getFxScalars(pair, fetch?)` — `fetch` defaults to the live Hermes fetcher but is injectable for tests. Resolves FEEDS: `direct` → one fetch → `rawToFxRate`; `cross` → two fetches → `rawToFxRate` each → `deriveCross`, publish_time = min. `fx_pair` = UTF-8 of the label.

- [ ] **Step 1: Write failing tests `ts/test/fx/pyth-client.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { getFxScalars } from "../../src/fx/pyth-client.js";
import { UnknownFxPair, FxFeedUnavailable, type RawPythPrice } from "../../src/fx/types.js";

const enc = (s: string) => new TextEncoder().encode(s);
const raw = (price: bigint, sec: bigint): RawPythPrice => ({ price, expo: -8, publishTimeSec: sec });

describe("getFxScalars", () => {
  // WHY: the three scalars must align byte-for-byte/scale-for-scale with the pay_one seam.
  it("direct pair: D9 rate, ms time, UTF-8 label", async () => {
    const fake = async (_id: string) => raw(108_500_000n, 1_700_000_000n); // 1.085
    const r = await getFxScalars("EUR/USD", fake);
    expect(r.fx_rate).toBe(1_085_000_000n);
    expect(r.fx_pyth_publish_time_ms).toBe(1_700_000_000_000n);
    expect(r.fx_pair).toEqual(enc("EUR/USD"));
  });

  it("cross pair EUR/GBP: divides legs, takes OLDER publish time", async () => {
    // EUR/USD 1.085 @ t=1700s, GBP/USD 1.250 @ t=1699s -> 0.868, min=1699s
    const fake = async (id: string) =>
      id.includes("EUR") || id === FEED_EURUSD ? raw(108_500_000n, 1_700_000_000n) : raw(125_000_000n, 1_699_000_000n);
    // Simpler: route by call order — see note below; here assert via two-arg fake.
    const r = await getFxScalars("EUR/GBP", makeRouted({
      "EUR/USD": raw(108_500_000n, 1_700_000_000n),
      "GBP/USD": raw(125_000_000n, 1_699_000_000n),
    }));
    expect(r.fx_rate).toBe(868_000_000n);
    expect(r.fx_pyth_publish_time_ms).toBe(1_699_000_000_000n);
    expect(r.fx_pair).toEqual(enc("EUR/GBP"));
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

// Helper: a fetcher that routes by which feed id maps to which pair via FEEDS.
import { FEEDS } from "../../src/fx/feeds.js";
const FEED_EURUSD = FEEDS["EUR/USD"].kind === "direct" ? FEEDS["EUR/USD"].id : "";
function makeRouted(byPair: Record<string, RawPythPrice>) {
  const byId: Record<string, RawPythPrice> = {};
  for (const [pair, r] of Object.entries(byPair)) {
    const spec = FEEDS[pair as keyof typeof FEEDS];
    if (spec.kind === "direct") byId[spec.id] = r;
  }
  return async (id: string) => {
    const r = byId[id];
    if (!r) throw new FxFeedUnavailable(`no fake for ${id}`);
    return r;
  };
}
```

> Note: the cross test relies on EUR/USD and GBP/USD being `direct` in FEEDS (true per Task 1). If Task 1 made EUR/GBP `direct`, replace the cross test with a direct-feed assertion for EUR/GBP and delete `makeRouted`/the first cross attempt.

- [ ] **Step 2: Run, verify fail**

Run: `cd ts && pnpm test pyth-client`
Expected: FAIL — `getFxScalars` not exported.

- [ ] **Step 3: Implement `ts/src/fx/pyth-client.ts`**

```ts
import { FEEDS, type FeedSpec } from "./feeds.js";
import { rawToFxRate, secToMs, deriveCross } from "./convert.js";
import { makeHermesFetcher, type FetchRawPrice } from "./hermes.js";
import { UnknownFxPair, type FxPair, type FxScalars } from "./types.js";

export async function getFxScalars(pair: FxPair, fetch: FetchRawPrice = makeHermesFetcher()): Promise<FxScalars> {
  const spec: FeedSpec | undefined = FEEDS[pair];
  if (!spec) throw new UnknownFxPair(`no feed for pair ${pair}`);
  const fx_pair = new TextEncoder().encode(pair);

  if (spec.kind === "direct") {
    const r = await fetch(spec.id);
    return { fx_pair, fx_rate: rawToFxRate(r), fx_pyth_publish_time_ms: secToMs(r.publishTimeSec) };
  }

  // cross: fx_rate = num/den at D9, publish_time = older (min) leg
  const numSpec = FEEDS[spec.num], denSpec = FEEDS[spec.den];
  if (numSpec.kind !== "direct" || denSpec.kind !== "direct") {
    throw new UnknownFxPair(`cross legs must be direct: ${spec.num}, ${spec.den}`);
  }
  const [n, d] = await Promise.all([fetch(numSpec.id), fetch(denSpec.id)]);
  const fx_rate = deriveCross(rawToFxRate(n), rawToFxRate(d));
  const olderSec = n.publishTimeSec < d.publishTimeSec ? n.publishTimeSec : d.publishTimeSec;
  return { fx_pair, fx_rate, fx_pyth_publish_time_ms: secToMs(olderSec) };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd ts && pnpm test pyth-client`
Expected: PASS.

- [ ] **Step 5: Full suite + build**

Run: `cd ts && pnpm test && pnpm build`
Expected: all green, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add ts/src/fx/pyth-client.ts ts/test/fx/pyth-client.test.ts
git commit -m "feat(ts): #7 getFxScalars orchestration (direct + cross, injectable fetcher)"
```

---

## Task 8: Live smoke check (manual, not a unit test)

**Files:**
- Create: `ts/src/fx/smoke.ts` (throwaway runner)

- [ ] **Step 1: Write `ts/src/fx/smoke.ts`**

```ts
import { getFxScalars } from "./pyth-client.js";

for (const pair of ["EUR/USD", "GBP/USD", "JPY/USD", "EUR/GBP"] as const) {
  const r = await getFxScalars(pair);
  console.log(pair, r.fx_rate.toString(), r.fx_pyth_publish_time_ms.toString());
}
```

- [ ] **Step 2: Run against live Hermes**

Run: `cd ts && pnpm tsx src/fx/smoke.ts` (or compile + node)
Expected: four lines, plausible D9 rates (EUR≈1.05–1.15e9, JPY≈6–7e6), publish_time within ~minutes of now in ms (13 digits).

If a rate or timestamp looks wrong, the SDK field mapping in `hermes.ts` is off — fix and re-run. **Fail loud:** do not proceed to docs until this passes.

- [ ] **Step 3: Remove smoke runner + commit**

```bash
rm ts/src/fx/smoke.ts
git add -A
git commit -m "test(ts): #7 verified live Hermes smoke (EUR/GBP/JPY/USD + cross)"
```

---

## Task 9: Docs — pin fx_rate scale, close notes item, roadmap

**Files:**
- Modify: `docs/specs/2026-05-30-payroll-flow-spec.md` (§7 area)
- Modify: `move-notes.md`

- [ ] **Step 1: Pin D9 scale in spec §7**

In the FX unit-contract box of `docs/specs/2026-05-30-payroll-flow-spec.md §7`, add a sentence:

> `fx_rate` is **D9 fixed point** (`round(price × 1e9)`, u64). Off-chain client (TODO #7) is the single producer; changing this scale post-mainnet is a D11 schema-migrating upgrade.

- [ ] **Step 2: Add Opt 1 roadmap to spec**

Append to the same section:

> **Roadmap — on-chain FX (Opt 1, opt-in):** for tamper-evident FX, a future Move adapter reads a Pyth `PriceInfoObject` and derives the same `(fx_rate, fx_pyth_publish_time)` scalars in-PTB. The seam signature is unchanged → non-breaking upgrade. Added cost: Pyth package dependency, a Hermes VAA `update_single_price_feed` per payday PTB, and a Pyth liveness dependency. Reserved for compliance customers who require verifiable FX.

- [ ] **Step 3: Close the fx-unit open item in move-notes**

In `move-notes.md`, mark the "(原)待修清單 #1 fx 單位釘死" item done: the off-chain client converts seconds→ms (`secToMs`) and pins D9 scale; seam consumers receive ms end-to-end.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-05-30-payroll-flow-spec.md move-notes.md
git commit -m "docs(payroll): #7 pin fx_rate D9 scale, Opt 1 roadmap, close fx-unit item"
```

---

## Task 10: Update progress

**Files:**
- Modify: `tasks/progress.md`

- [ ] **Step 1: Mark #7 done**

Set TODO #7 to `[x]` with: off-chain Pyth client, D9 fx_rate, sec→ms contract, EUR/GBP cross, N tests green, zero Move change, Opt 1 in roadmap. Note next = #8 TS PTB orchestrator (consumes `getFxScalars`; remember `begin_period()` + `fx_pair` operator invariant + u64 BCS boundary).

- [ ] **Step 2: Commit**

```bash
git add tasks/progress.md
git commit -m "docs(payroll): #7 done — progress update"
```

---

## Self-Review

- **Spec coverage:** Opt 2 (whole plan) · D9 fx_rate (T4) · sec→ms (T4) · seam unchanged / no Move (verified, T8 smoke + no Move tasks) · EUR/GBP cross (T1 decision, T5, T7) · red-team price≤0/overflow/unknown/feed-unavailable (T4,T5,T7) · display format BASE/QUOTE UTF-8 (T7) · [A] u64 BCS boundary (T10 handoff note for #8) · [B] fx_pair operator invariant (already in move-notes; T10 reminder) · [C] cross auditor reproducibility (spec already has it; derivation logged via FEEDS) · spec §7 scale + Opt 1 roadmap (T9). No gaps.
- **Placeholder scan:** feed ids in `feeds.ts` are intentional fill-from-Task-1 slots with an explicit "do not invent" guard, resolved before any test that needs them — not a plan placeholder. SDK field names flagged for version-check in T6. No TODO/TBD code steps.
- **Type consistency:** `RawPythPrice{price,expo,publishTimeSec}`, `FxScalars{fx_pair,fx_rate,fx_pyth_publish_time_ms}`, `FetchRawPrice`, `FeedSpec{direct|cross}`, errors — names consistent across T2/T4/T5/T6/T7.
