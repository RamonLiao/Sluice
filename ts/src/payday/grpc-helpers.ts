import { bcs } from "@mysten/sui/bcs";
import type { DryRunResult, ExecResult } from "./execute-types.js";

export interface GasLike {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}
type StatusLike = { success: boolean; error: string | null };
export interface TxResponseLike {
  transaction: { digest?: string; effects: { status: StatusLike; gasUsed?: GasLike } };
}

/** Net audit cost. effects.gasUsed is four BCS-string fields, not a scalar (1.45.2). */
export function computeNetGas(g: GasLike): bigint {
  return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
}

/** Map a core execute response to the port's ExecResult. 'FailedTransaction' is OUR sentinel,
 *  emitted when effects.status.success === false — NOT an SDK field (1.45.2 has no res.kind). */
export function mapExecResult(res: TxResponseLike): ExecResult {
  const { digest, effects } = res.transaction;
  const gasUsed = effects.gasUsed ? computeNetGas(effects.gasUsed) : null;
  if (effects.status.success) {
    return { kind: "success", digest: digest ?? "", error: null, gasUsed };
  }
  return { kind: "FailedTransaction", digest: digest ?? "", error: effects.status.error, gasUsed };
}

export function mapDryRun(res: TxResponseLike): DryRunResult {
  const { status } = res.transaction.effects;
  return status.success ? { ok: true, error: null } : { ok: false, error: status.error };
}

/** Payroll<T> BCS layout, field order mirrors payroll.move:65-82. Balance<T> = u64, Table = {id,size}. */
export const PAYROLL_BCS = bcs.struct("Payroll", {
  id: bcs.Address,
  version: bcs.u64(),
  owner_cap_id: bcs.Address,
  escrow_id: bcs.Address,
  funding: bcs.u64(),
  employees: bcs.struct("Table", { id: bcs.Address, size: bcs.u64() }),
  current_period: bcs.u64(),
});

export function decodeCurrentPeriod(bytes: Uint8Array): bigint {
  return BigInt(PAYROLL_BCS.parse(bytes).current_period);
}
