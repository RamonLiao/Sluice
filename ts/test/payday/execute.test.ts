import { describe, it, expect } from "vitest";
import { assertPeriodGate } from "../../src/payday/execute.js";
import { PeriodGateError } from "../../src/payday/execute-types.js";

describe("assertPeriodGate", () => {
  it("no expectedPeriod => no gate (demo mode)", () => {
    expect(() => assertPeriodGate(5n, 0)).not.toThrow();
    expect(() => assertPeriodGate(5n, 3)).not.toThrow();
  });

  it("fresh run requires current_period === expectedPeriod - 1 (begin_period will advance it)", () => {
    expect(() => assertPeriodGate(0n, 0, 1n)).not.toThrow(); // chain at 0, paying period 1
  });

  it("fresh run throws if begin_period already ran (double-pay risk)", () => {
    // chain already at 1 but caller thinks this is a fresh payday for period 1:
    // re-running begin_period would open period 2 and re-pay everyone -> reject.
    expect(() => assertPeriodGate(1n, 0, 1n)).toThrow(PeriodGateError);
  });

  it("resume requires current_period === expectedPeriod (begin_period already landed)", () => {
    expect(() => assertPeriodGate(1n, 2, 1n)).not.toThrow();
    expect(() => assertPeriodGate(0n, 2, 1n)).toThrow(PeriodGateError); // period not advanced -> drift
    expect(() => assertPeriodGate(2n, 2, 1n)).toThrow(PeriodGateError); // advanced too far -> drift
  });
});

import { Transaction } from "@mysten/sui/transactions";
import { executePayday } from "../../src/payday/execute.js";
import type { PaydayClient, PaydaySigner } from "../../src/payday/execute-types.js";
import type { PaydayPlan } from "../../src/payday/types.js";

const ADDR = "0x" + "a".repeat(64);
const signer: PaydaySigner = { toSuiAddress: () => ADDR };

function makePlan(chunkCount: number): PaydayPlan {
  const transactions: Transaction[] = [];
  const chunks: PaydayPlan["chunks"] = [];
  for (let i = 0; i < chunkCount; i++) {
    transactions.push(new Transaction());
    chunks.push({ employees: ["0x" + String(i).padStart(64, "0")], hasBeginPeriod: i === 0 });
  }
  return { transactions, chunks };
}

interface MockOpts {
  currentPeriod?: bigint;
  failExecAt?: number;  // 0-based index AMONG signAndExecute calls that returns FailedTransaction
  dryRunOk?: boolean;
  throwWaitAt?: number; // 0-based index among waitForConfirm calls that throws
}

function makeMockClient(opts: MockOpts = {}) {
  const calls: string[] = [];
  let execN = 0;
  let waitN = 0;
  const client: PaydayClient = {
    async getCurrentPeriod() {
      calls.push("getCurrentPeriod");
      return opts.currentPeriod ?? 0n;
    },
    async dryRunTransaction() {
      calls.push("dryRun");
      const ok = opts.dryRunOk ?? true;
      return { ok, error: ok ? null : "simulated abort" };
    },
    async signAndExecute() {
      const idx = execN++;
      calls.push(`exec:${idx}`);
      const failed = opts.failExecAt === idx;
      return {
        kind: failed ? "FailedTransaction" : "success",
        digest: `dig${idx}`,
        error: failed ? "MoveAbort 11" : null,
        gasUsed: failed ? null : 1000n,
      };
    },
    async waitForConfirm() {
      const idx = waitN++;
      calls.push(`wait:${idx}`);
      if (opts.throwWaitAt === idx) throw new Error("wait timeout");
    },
  };
  return { client, calls };
}

describe("executePayday — happy path", () => {
  it("runs all chunks, returns success receipts + completed", async () => {
    const { client, calls } = makeMockClient();
    const plan = makePlan(3);
    const res = await executePayday(plan, "0xpayroll", signer, client, { preflight: false });

    expect(res.completed).toBe(true);
    expect(res.nextResumeFrom).toBeNull();
    expect(res.receipts.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(res.receipts.map((r) => r.digest)).toEqual(["dig0", "dig1", "dig2"]);
    expect(res.receipts.every((r) => r.gasUsed === 1000n)).toBe(true);
    // WHY: every chunk in one payday is paid at the same period (begin_period runs once).
    // fresh run: chain at 0 -> payday period 1.
    expect(res.receipts.every((r) => r.paidAtPeriod === 1n)).toBe(true);
    expect(calls).toContain("exec:2");
  });
});

describe("executePayday — H2 sequential ordering", () => {
  it("never sends chunk[i+1] before chunk[i] confirms (defends EAlreadyPaidThisPeriod / equivocation)", async () => {
    const { client, calls } = makeMockClient();
    const plan = makePlan(3);
    await executePayday(plan, "0xpayroll", signer, client, { preflight: false });

    // exec:i MUST be immediately followed by wait:i, before exec:(i+1).
    const order = calls.filter((c) => c.startsWith("exec") || c.startsWith("wait"));
    expect(order).toEqual(["exec:0", "wait:0", "exec:1", "wait:1", "exec:2", "wait:2"]);
  });
});

describe("executePayday — fail-stop", () => {
  it("stops at first failed chunk, never submits later chunks, sets nextResumeFrom", async () => {
    const { client, calls } = makeMockClient({ failExecAt: 1 });
    const plan = makePlan(3);
    const res = await executePayday(plan, "0xpayroll", signer, client, { preflight: false });

    expect(res.completed).toBe(false);
    expect(res.nextResumeFrom).toBe(1);
    expect(res.receipts.map((r) => r.status)).toEqual(["success", "failure", "skipped"]);
    expect(res.receipts[1]!.error).toBe("MoveAbort 11");
    // WHY: money fails loud — chunk[2] must NEVER be submitted after chunk[1] aborts.
    expect(calls).not.toContain("exec:2");
  });
});

describe("executePayday — dryRun preflight", () => {
  it("aborts before any money moves when preflight dryRun fails", async () => {
    const { client, calls } = makeMockClient({ dryRunOk: false });
    const plan = makePlan(3);
    const res = await executePayday(plan, "0xpayroll", signer, client, { preflight: true });

    expect(res.completed).toBe(false);
    expect(res.nextResumeFrom).toBe(0);
    expect(res.receipts[0]!.status).toBe("failure");
    expect(res.receipts[0]!.error).toBe("simulated abort");
    // WHY: zero submissions — dryRun is the pre-money insurance gate.
    expect(calls.filter((c) => c.startsWith("exec"))).toEqual([]);
  });

  it("preflight dryRuns only the resumeFrom chunk, not every chunk", async () => {
    const { client, calls } = makeMockClient();
    const plan = makePlan(3);
    await executePayday(plan, "0xpayroll", signer, client, { preflight: true });
    expect(calls.filter((c) => c === "dryRun").length).toBe(1);
  });
});

describe("executePayday — resume", () => {
  it("resumeFrom=2 marks earlier chunks skipped and submits only chunk[2]", async () => {
    // chain already at period 1 (begin_period landed in a prior session).
    const { client, calls } = makeMockClient({ currentPeriod: 1n });
    const plan = makePlan(3);
    const res = await executePayday(plan, "0xpayroll", signer, client, {
      resumeFrom: 2,
      preflight: false,
    });

    expect(res.completed).toBe(true);
    expect(res.receipts.map((r) => r.status)).toEqual(["skipped", "skipped", "success"]);
    // WHY: only one exec call, and it is the FIRST exec (chunk 0/1 never re-run -> begin_period not re-run).
    expect(calls.filter((c) => c.startsWith("exec"))).toEqual(["exec:0"]);
    // resumed payday pays at the already-advanced period 1 (NOT 2).
    expect(res.receipts[2]!.paidAtPeriod).toBe(1n);
  });
});

describe("executePayday — double-pay gate integration", () => {
  it("throws PeriodGateError on fresh re-run when begin_period already advanced the period", async () => {
    // caller thinks fresh payday for period 1, but chain is already at 1 -> re-running begin_period
    // would open period 2 and re-pay everyone. Reject before any submission.
    const { client, calls } = makeMockClient({ currentPeriod: 1n });
    const plan = makePlan(3);
    await expect(
      executePayday(plan, "0xpayroll", signer, client, { resumeFrom: 0, expectedPeriod: 1n }),
    ).rejects.toBeInstanceOf(PeriodGateError);
    expect(calls.filter((c) => c.startsWith("exec"))).toEqual([]);
  });

  it("allows fresh run when chain is one period behind expected", async () => {
    const { client } = makeMockClient({ currentPeriod: 0n });
    const plan = makePlan(1);
    const res = await executePayday(plan, "0xpayroll", signer, client, {
      resumeFrom: 0,
      expectedPeriod: 1n,
      preflight: false,
    });
    expect(res.completed).toBe(true);
  });
});
