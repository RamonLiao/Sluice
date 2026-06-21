import {
  buildPayday, executePayday, getFxScalars,
  type FxPair, type FxScalars, type PaydayClient, type PaydaySigner,
  type PaydayResult, type PaydayConfig, type PaydayEmployee,
} from "@payroll-flow/orchestrator";
import type { EmployeeRow, PayrollReader } from "../chain/payroll-reader.js";
import { TESTNET } from "../config/testnet.js";

const JURISDICTION_PAIR: Record<string, FxPair> = {
  EU: "EUR/USD", GB: "GBP/USD", JP: "JPY/USD", EG: "EUR/GBP",
};

export function jurisdictionToPair(j: Uint8Array): FxPair {
  const key = new TextDecoder().decode(j);
  const pair = JURISDICTION_PAIR[key];
  if (!pair) throw new Error(`no FX pair mapped for jurisdiction "${key}"`);
  return pair;
}

const CONFIG: PaydayConfig = {
  packageId: TESTNET.packageId, coinType: TESTNET.coinType, payrollId: TESTNET.payrollId,
  ownerCapId: TESTNET.ownerCapId, escrowId: TESTNET.escrowId, scallopId: TESTNET.scallopId,
  naviId: TESTNET.naviId, clockId: TESTNET.clockId,
};

export async function runPayday(args: {
  rows: EmployeeRow[]; reader: PayrollReader; client: PaydayClient; signer: PaydaySigner;
  resumeFrom?: number; fetchFx?: typeof getFxScalars;
}): Promise<PaydayResult> {
  const fetchFx = args.fetchFx ?? getFxScalars;
  const active = args.rows.filter((r) => r.active);
  const employees: PaydayEmployee[] = active.map((r) => ({ addr: r.addr, pair: jurisdictionToPair(r.jurisdiction) }));

  const pairs = [...new Set(employees.map((e) => e.pair))];
  const fxByPair = new Map<string, FxScalars>();
  for (const p of pairs) fxByPair.set(p, await fetchFx(p));   // fail loud if Hermes down

  const plan = buildPayday(employees, fxByPair, CONFIG);

  const resumeFrom = args.resumeFrom ?? 0;
  const currentPeriod = await args.client.getCurrentPeriod(TESTNET.payrollId);
  const expectedPeriod = resumeFrom === 0 ? currentPeriod + 1n : currentPeriod; // C2: mandatory gate

  return executePayday(plan, TESTNET.payrollId, args.signer, args.client, { resumeFrom, expectedPeriod });
}
