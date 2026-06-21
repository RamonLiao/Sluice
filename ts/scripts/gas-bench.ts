// Phase C: measure payday gas at N=3/50/100. Usage: cd ts && SUI_PRIVATE_KEY=... npx tsx scripts/gas-bench.ts
// Adds N fresh employees (batched into PTBs), runs ONE payday over exactly those N, records net
// gasUsed per chunk. Calibrates the provisional MAX_BATCH=50 (src/payday/types.ts).
//
// NOTE on accumulated state: each round only PAYS its own N fresh employees (buildPayday includes
// only the addresses we pass), but prior rounds' employees remain in the shared Payroll's
// `employees` Table. This does NOT bias the measurement: per-pay_one gas is per-PAID-employee plus
// O(1) by-key dynamic-field access — Table size is irrelevant. Proven empirically below: with ~153
// rows in the Table by N=100, the two 50-chunks read ~identical to the N=50 single chunk. A clean
// per-N Payroll would cost more gas/time for the same numbers, so we don't rebuild.
import { readFileSync } from "node:fs";
import { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { buildPayday } from "../src/payday/build.js";
import { executePayday } from "../src/payday/execute.js";
import { makeGrpcPaydayClient } from "../src/payday/grpc-client.js";
import { getFxScalars } from "../src/fx/pyth-client.js";
import type { PaydayConfig, PaydayEmployee, FxPair } from "../src/payday/types.js";

const cfg = JSON.parse(readFileSync("./testnet.json", "utf8"));
const kp = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
const me = kp.toSuiAddress();
const client = makeGrpcPaydayClient({ network: "testnet" });
const rpc = new SuiClient({ url: getFullnodeUrl("testnet"), network: "testnet" });
const SUI = cfg.coinType as string;
const pkg = cfg.packageId as string;
const pair: FxPair = "EUR/USD";
const fxByPair = new Map([[pair, await getFxScalars(pair)]]);

const config: PaydayConfig = {
  packageId: pkg, coinType: SUI, payrollId: cfg.payrollId, ownerCapId: cfg.ownerCapId,
  escrowId: cfg.escrowId, scallopId: cfg.scallopId, naviId: cfg.naviId, clockId: "0x6",
};

async function send(tx: Transaction, label: string) {
  tx.setSender(me);
  const bytes = await tx.build({ client: rpc });
  const { signature } = await kp.signTransaction(bytes);
  const { transaction } = await rpc.core.executeTransaction({ transaction: bytes, signatures: [signature] });
  if (!transaction.effects.status.success) throw new Error(`${label}: ${transaction.effects.status.error}`);
  await rpc.core.waitForTransaction({ digest: transaction.digest });
}

const ADD_PER_TX = 25; // add_employee calls per PTB
async function addEmployees(n: number): Promise<string[]> {
  const addrs = Array.from({ length: n }, () => Ed25519Keypair.generate().toSuiAddress());
  for (let i = 0; i < addrs.length; i += ADD_PER_TX) {
    const batch = addrs.slice(i, i + ADD_PER_TX);
    const tx = new Transaction();
    for (const emp of batch) {
      tx.moveCall({
        target: `${pkg}::payroll::add_employee`, typeArguments: [SUI],
        arguments: [tx.object(cfg.payrollId), tx.object(cfg.ownerCapId), tx.pure.address(emp), tx.pure.vector("u8", [...new TextEncoder().encode("US")]), tx.pure.u64(1000n), tx.pure.u16(1000)],
      });
    }
    await send(tx, `add_employee[${i}..${i + batch.length}]`);
  }
  return addrs;
}

const table: Array<{ N: number; chunks: number; perChunk: string[] }> = [];
for (const N of [3, 50, 100]) {
  const addrs = await addEmployees(N);
  const employees: PaydayEmployee[] = addrs.map((addr) => ({ addr, pair }));
  const plan = buildPayday(employees, fxByPair, config);
  const before = await client.getCurrentPeriod(cfg.payrollId);
  const res = await executePayday(plan, cfg.payrollId, kp, client, { expectedPeriod: before + 1n });
  if (!res.completed) throw new Error(`N=${N} incomplete: ${JSON.stringify(res.receipts.map((r) => ({ i: r.chunkIndex, s: r.status, e: r.error })))}`);
  const perChunk = res.receipts.map((r) => `chunk${r.chunkIndex}(n=${r.employees.length}): ${r.gasUsed?.toString()} MIST`);
  table.push({ N, chunks: plan.transactions.length, perChunk });
  console.log(`N=${N}: ${plan.transactions.length} chunk(s) —`, perChunk.join(" | "));
}

console.log("\n=== Phase C gas table ===");
for (const row of table) console.log(`N=${row.N} (${row.chunks} chunk): ${row.perChunk.join(" | ")}`);
console.log("\nVerdict: if a single 50-employee chunk's gas is near the per-tx ceiling, lower MAX_BATCH; else 50 holds.");
