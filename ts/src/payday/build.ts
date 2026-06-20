import { Transaction } from "@mysten/sui/transactions";
import type { FxScalars } from "../fx/types.js";
import {
  type PaydayEmployee,
  type PaydayConfig,
  type PaydayPlan,
  MAX_BATCH,
  DuplicatePayee,
  MissingFxScalars,
  FxPairLabelMismatch,
} from "./types.js";
import { chunk } from "./chunk.js";

const decoder = new TextDecoder();

/** Fail-loud preflight: no dup payees, every pair has scalars, every label matches its bytes. */
export function assertPaydayInputs(
  employees: readonly PaydayEmployee[],
  fxByPair: ReadonlyMap<string, FxScalars>,
): void {
  const seen = new Set<string>();
  for (const e of employees) {
    if (seen.has(e.addr)) throw new DuplicatePayee(`payee ${e.addr} appears twice`);
    seen.add(e.addr);
    const fx = fxByPair.get(e.pair);
    if (!fx) throw new MissingFxScalars(`no fx scalars for pair ${e.pair}`);
    if (decoder.decode(fx.fx_pair) !== e.pair) {
      throw new FxPairLabelMismatch(`scalars for ${e.pair} carry label ${decoder.decode(fx.fx_pair)}`);
    }
  }
}

function appendBeginPeriod(tx: Transaction, cfg: PaydayConfig): void {
  tx.moveCall({
    target: `${cfg.packageId}::payroll::begin_period`,
    typeArguments: [cfg.coinType],
    arguments: [tx.object(cfg.payrollId), tx.object(cfg.ownerCapId)],
  });
}

function appendPayOne(tx: Transaction, cfg: PaydayConfig, addr: string, fx: FxScalars): void {
  tx.moveCall({
    target: `${cfg.packageId}::payroll::pay_one`,
    typeArguments: [cfg.coinType],
    arguments: [
      tx.object(cfg.payrollId),
      tx.object(cfg.ownerCapId),
      tx.object(cfg.escrowId),
      tx.object(cfg.scallopId),
      tx.object(cfg.naviId),
      tx.pure.address(addr),
      tx.pure.vector("u8", [...fx.fx_pair]),
      tx.pure.u64(fx.fx_rate),
      tx.pure.u64(fx.fx_pyth_publish_time_ms),
      tx.object(cfg.clockId),
    ],
  });
}

/**
 * Build the PTBs for one payday. PURE: no signing, no submission, no chain reads.
 * begin_period is prepended to chunk[0] only and advances the period once.
 * transactions[] order is mandatory submission order.
 */
export function buildPayday(
  employees: readonly PaydayEmployee[],
  fxByPair: ReadonlyMap<string, FxScalars>,
  config: PaydayConfig,
): PaydayPlan {
  assertPaydayInputs(employees, fxByPair);
  const batches = chunk(employees, MAX_BATCH);
  const plan: PaydayPlan = { transactions: [], chunks: [] };
  batches.forEach((batch, idx) => {
    const tx = new Transaction();
    const hasBeginPeriod = idx === 0;
    if (hasBeginPeriod) appendBeginPeriod(tx, config);
    for (const e of batch) {
      appendPayOne(tx, config, e.addr, fxByPair.get(e.pair)!);
    }
    plan.transactions.push(tx);
    plan.chunks.push({ employees: batch.map((e) => e.addr), hasBeginPeriod });
  });
  return plan;
}
