import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Transaction } from "@mysten/sui/transactions";
import type {
  PaydayClient, PaydaySigner, DryRunResult, ExecResult,
} from "@payroll-flow/orchestrator";

export type SignAndExecuteFn = (tx: Transaction) => Promise<{ digest: string }>;

/** Implements the orchestrator PaydayClient over a browser wallet. Builds nothing itself: the wallet
 *  resolves+signs each Transaction at call time, so executePayday's per-chunk loop keeps owned-input
 *  versions fresh (C1). One instance per Run Payroll invocation. */
export class DappKitPaydayClient implements PaydayClient {
  constructor(
    private readonly sui: SuiJsonRpcClient,
    private readonly signAndExecuteFn: SignAndExecuteFn,
  ) {}

  async getCurrentPeriod(payrollId: string): Promise<bigint> {
    const o = await this.sui.getObject({ id: payrollId, options: { showContent: true } });
    return BigInt((o.data!.content as any).fields.current_period);
  }

  async dryRunTransaction(tx: Transaction): Promise<DryRunResult> {
    // MAY build — simulation only, not the money path (C1 applies only to signAndExecute)
    const bytes = await tx.build({ client: this.sui as any });
    const res = await this.sui.dryRunTransactionBlock({ transactionBlock: bytes });
    const ok = res.effects.status.status === "success";
    return { ok, error: ok ? null : res.effects.status.error ?? "dry-run failed" };
  }

  async signAndExecute(tx: Transaction, _signer: PaydaySigner): Promise<ExecResult> {
    // MUST NOT call tx.build() here — wallet builds+signs+executes at call time (C1)
    try {
      const { digest } = await this.signAndExecuteFn(tx);
      return { kind: "success", digest, error: null, gasUsed: null };
    } catch (e) {
      return { kind: "FailedTransaction", digest: "", error: String(e), gasUsed: null };
    }
  }

  async waitForConfirm(digest: string): Promise<void> {
    await this.sui.waitForTransaction({ digest, timeout: 60_000 });
  }
}
