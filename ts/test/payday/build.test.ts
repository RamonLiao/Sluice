import { describe, it, expect } from "vitest";
import { assertPaydayInputs, buildPayday } from "../../src/payday/build.js";
import { DuplicatePayee, MissingFxScalars, FxPairLabelMismatch } from "../../src/payday/types.js";
import type { FxScalars } from "../../src/fx/types.js";
import type { PaydayConfig, PaydayEmployee } from "../../src/payday/types.js";
import type { Transaction } from "@mysten/sui/transactions";

const scalars = (pair: string): FxScalars => ({
  fx_pair: new TextEncoder().encode(pair),
  fx_rate: 1_085_000_000n,
  fx_pyth_publish_time_ms: 1_700_000_000_000n,
});
const fxMap = new Map<string, FxScalars>([["EUR/USD", scalars("EUR/USD")]]);

// Pad a short number to a valid 32-byte Sui address
const addr = (n: number): string => "0x" + n.toString(16).padStart(64, "0");

// Test config with valid 32-byte hex addresses (getData() validates address format)
const cfg: PaydayConfig = {
  packageId: addr(0xaa),
  coinType: `${addr(0xaa)}::usdc::USDC`,
  payrollId: addr(0x01),
  ownerCapId: addr(0x02),
  escrowId: addr(0x03),
  scallopId: addr(0x04),
  naviId: addr(0x05),
  clockId: addr(0x06),
};

const emps = (n: number): PaydayEmployee[] =>
  Array.from({ length: n }, (_, i) => ({ addr: addr(i + 0x100), pair: "EUR/USD" as const }));

// Helpers that read raw command list from a Transaction
function commands(tx: Transaction) {
  return tx.getData().commands;
}

// WHY: MoveCall is the $kind discriminator in @mysten/sui 1.45.2 getData() output
function moveTargets(tx: Transaction): string[] {
  return commands(tx)
    .filter((c): c is Extract<typeof c, { MoveCall: unknown }> => "MoveCall" in c)
    .map((c) => {
      const mc = (c as { MoveCall: { package: string; module: string; function: string } }).MoveCall;
      return `${mc.package}::${mc.module}::${mc.function}`;
    });
}

describe("buildPayday", () => {
  // WHY: chunk count == PTB count; a miscount silently drops or doubles payees.
  it("0 employees -> empty plan, no spurious begin_period", () => {
    const plan = buildPayday([], fxMap, cfg);
    expect(plan.transactions).toEqual([]);
    expect(plan.chunks).toEqual([]);
  });
  it("51 employees -> 2 chunks [50,1]", () => {
    const plan = buildPayday(emps(51), fxMap, cfg);
    expect(plan.chunks.map((c) => c.employees.length)).toEqual([50, 1]);
  });
  // WHY: begin_period must run exactly once per payday, in the first PTB only;
  // a second begin_period double-advances the period (spec D10).
  it("prepends begin_period to chunk[0] only", () => {
    const plan = buildPayday(emps(51), fxMap, cfg);
    expect(plan.chunks[0]!.hasBeginPeriod).toBe(true);
    expect(plan.chunks[1]!.hasBeginPeriod).toBe(false);
    expect(moveTargets(plan.transactions[0]!)[0]).toBe(`${addr(0xaa)}::payroll::begin_period`);
    expect(moveTargets(plan.transactions[1]!).every((t) => t.endsWith("::pay_one"))).toBe(true);
  });
  it("chunk[0] has begin_period + one pay_one per employee", () => {
    const plan = buildPayday(emps(3), fxMap, cfg);
    const t = moveTargets(plan.transactions[0]!);
    expect(t[0]).toBe(`${addr(0xaa)}::payroll::begin_period`);
    expect(t.filter((x) => x.endsWith("::pay_one")).length).toBe(3);
  });
  // WHY: bigint discipline exists because publish_time (~1.7e12) loses precision as a JS number;
  // the u64 input must round-trip exactly.
  it("encodes fx_rate as u64 without precision loss", () => {
    const big = 18_446_744_073_709_551_615n; // u64::MAX
    const fx = new Map([["EUR/USD", { fx_pair: new TextEncoder().encode("EUR/USD"), fx_rate: big, fx_pyth_publish_time_ms: 1_700_000_000_000n }]]);
    const plan = buildPayday([{ addr: addr(0x999), pair: "EUR/USD" }], fx, cfg);
    const inputs = plan.transactions[0]!.getData().inputs;
    // u64::MAX little-endian bytes present among pure inputs
    // u64::MAX = 0xffffffffffffffff LE = all 0xff bytes; base64: "//////////8="
    const u64MaxB64 = "//////////8=";
    const hasMax = inputs.some((i) => "Pure" in i && i.Pure !== undefined && (i as { Pure: { bytes: string } }).Pure.bytes === u64MaxB64);
    expect(hasMax).toBe(true);
  });
  it("propagates invariant failures (duplicate payee)", () => {
    expect(() => buildPayday([{ addr: addr(0x1), pair: "EUR/USD" }, { addr: addr(0x1), pair: "EUR/USD" }], fxMap, cfg)).toThrow();
  });
});

describe("assertPaydayInputs", () => {
  // WHY: silently skipping or mislabeling a payee corrupts the on-chain compliance event
  // the auditor relies on — the operator invariant from move-notes open-task #4.
  it("accepts well-formed inputs", () => {
    expect(() => assertPaydayInputs([{ addr: "0x1", pair: "EUR/USD" }], fxMap)).not.toThrow();
  });
  it("rejects duplicate payee address (would abort whole PTB on-chain)", () => {
    expect(() =>
      assertPaydayInputs(
        [{ addr: "0x1", pair: "EUR/USD" }, { addr: "0x1", pair: "EUR/USD" }],
        fxMap,
      ),
    ).toThrow(DuplicatePayee);
  });
  it("rejects employee whose pair has no scalars (never skip a payee)", () => {
    expect(() => assertPaydayInputs([{ addr: "0x1", pair: "GBP/USD" }], fxMap)).toThrow(MissingFxScalars);
  });
  it("rejects scalars whose fx_pair bytes mismatch the employee pair", () => {
    const bad = new Map<string, FxScalars>([["EUR/USD", scalars("GBP/USD")]]);
    expect(() => assertPaydayInputs([{ addr: "0x1", pair: "EUR/USD" }], bad)).toThrow(FxPairLabelMismatch);
  });
});
