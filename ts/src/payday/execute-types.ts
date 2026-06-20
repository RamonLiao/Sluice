import type { Transaction } from "@mysten/sui/transactions";

/** Minimal signer surface the executor needs; a real @mysten/sui Signer/Keypair satisfies it. */
export interface PaydaySigner {
  toSuiAddress(): string;
}

export interface DryRunResult {
  ok: boolean;
  error: string | null;
}

export interface ExecResult {
  kind: "success" | "FailedTransaction"; // core-API discriminator (NOT effects.status)
  digest: string;
  error: string | null;
  gasUsed: bigint | null;
}

/** Narrow port over the chain. Prod = SuiGrpcClient adapter; tests = mock. */
export interface PaydayClient {
  getCurrentPeriod(payrollId: string): Promise<bigint>;
  dryRunTransaction(tx: Transaction): Promise<DryRunResult>; // no signer; sender set on tx by executor
  signAndExecute(tx: Transaction, signer: PaydaySigner): Promise<ExecResult>;
  waitForConfirm(digest: string): Promise<void>;
}

export interface ChunkReceipt {
  chunkIndex: number;
  digest: string | null;        // null = dryRun-failed / never submitted
  status: "success" | "failure" | "skipped"; // skipped = not attempted this run
  employees: string[];
  paidAtPeriod: bigint | null;  // the payday's period at confirm time (audit)
  gasUsed: bigint | null;
  error: string | null;
}

export interface PaydayResult {
  receipts: ChunkReceipt[];     // one per chunk, aligned to plan.chunks
  completed: boolean;
  nextResumeFrom: number | null;
}

export interface ExecutePaydayOpts {
  resumeFrom?: number;
  expectedPeriod?: bigint;
  preflight?: boolean;
}

export class PeriodGateError extends Error {}
export class ResumeRangeError extends Error {}
