// Live testnet e2e. Usage: cd ts && SUI_PRIVATE_KEY=... npx tsx scripts/e2e-payday.ts
// Drives executePayday against the deployed payroll: full payday, period-advance check, H1 clock
// assertion, and a resume-gate (double-run blocked) check.
import { readFileSync } from "node:fs";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { buildPayday } from "../src/payday/build.js";
import { executePayday } from "../src/payday/execute.js";
import { makeGrpcPaydayClient, assertClockImmutable } from "../src/payday/grpc-client.js";
import { getFxScalars } from "../src/fx/pyth-client.js";
import { PeriodGateError } from "../src/payday/execute-types.js";
import type { PaydayConfig, PaydayEmployee, FxPair } from "../src/payday/types.js";

const cfg = JSON.parse(readFileSync("./testnet.json", "utf8"));
const kp = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
const client = makeGrpcPaydayClient({ network: "testnet" });
const rpc = new SuiClient({ url: getFullnodeUrl("testnet") });

const config: PaydayConfig = {
  packageId: cfg.packageId, coinType: cfg.coinType, payrollId: cfg.payrollId,
  ownerCapId: cfg.ownerCapId, escrowId: cfg.escrowId, scallopId: cfg.scallopId,
  naviId: cfg.naviId, clockId: "0x6",
};

const pair: FxPair = "EUR/USD";
const employees: PaydayEmployee[] = cfg.employees.map((addr: string) => ({ addr, pair }));
const fxByPair = new Map([[pair, await getFxScalars(pair)]]);

// --- H1: build a throwaway chunk[0], assert clock 0x6 resolved immutable (offline, deterministic) ---
const h1tx = buildPayday(employees, fxByPair, config).transactions[0]!;
h1tx.setSender(kp.toSuiAddress());
await h1tx.build({ client: rpc });
const data = h1tx.getData() as { inputs: Parameters<typeof assertClockImmutable>[0] };
assertClockImmutable(data.inputs);
console.log("H1 OK: clock 0x6 resolved mutable:false");

// --- full payday (fresh plan, executor owns its builds) ---
const plan = buildPayday(employees, fxByPair, config);
const before = await client.getCurrentPeriod(cfg.payrollId);
const result = await executePayday(plan, cfg.payrollId, kp, client, { expectedPeriod: before + 1n });

if (!result.completed) throw new Error(`payday incomplete: ${JSON.stringify(result.receipts, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
const after = await client.getCurrentPeriod(cfg.payrollId);
if (after !== before + 1n) throw new Error(`period did not advance by 1: ${before} -> ${after}`);
for (const r of result.receipts) if (r.status !== "success") throw new Error(`chunk ${r.chunkIndex} not success: ${r.error}`);
console.log("E2E OK:", { before: before.toString(), after: after.toString(), receipts: result.receipts.map((r) => ({ i: r.chunkIndex, digest: r.digest, gas: r.gasUsed?.toString() })) });

// --- resume gate: re-running the SAME fresh plan must be blocked (no double begin_period / double-pay) ---
const plan2 = buildPayday(employees, fxByPair, config);
try {
  await executePayday(plan2, cfg.payrollId, kp, client, { expectedPeriod: before + 1n });
  throw new Error("RESUME FAIL: second full run should have been gated");
} catch (e) {
  if (!(e instanceof PeriodGateError)) throw e;
  console.log("RESUME GATE OK:", e.message);
}
