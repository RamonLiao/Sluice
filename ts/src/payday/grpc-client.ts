import type { Transaction } from "@mysten/sui/transactions";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import type { PaydayClient, PaydaySigner, DryRunResult, ExecResult } from "./execute-types.js";
import { mapExecResult, mapDryRun, decodeCurrentPeriod, type TxResponseLike } from "./grpc-helpers.js";

// ⚠ TRANSITIONAL — runs on JSON-RPC today; FULL gRPC UPGRADE PENDING (2026-06-21).
// @mysten/sui@1.45.2's gRPC client is unusable against the live testnet node (1.73.1) on BOTH paths:
//   1. resolve  — `GrpcCoreClient.resolveTransactionData` throws "Transaction resolution is not
//                  supported with the GRPC client" (only the jsonRpc resolver is implemented).
//   2. execute  — its hardcoded readMask path "transaction.transaction" (grpc/core.js:212) is
//                  rejected by the node: `INVALID_ARGUMENT: invalid read_mask path`.
// So the entire adapter currently runs on the JSON-RPC SuiClient (resolve + dryRun + execute + wait
// + getObject). The class/port/factory signatures are transport-agnostic on purpose: when a future
// SDK fixes gRPC resolve + readMask, swap ONLY the factory internals (point core at grpc.core, keep
// JSON-RPC for resolve until its gRPC path lands) — nothing else changes. Tracked: move-notes / progress.
// TODO(gRPC-upgrade): replace the JSON-RPC core below with SuiGrpcClient once 1.x gRPC works on testnet.

/** Minimal client.core surface the adapter uses; the real SuiGrpcClient.core satisfies it. */
export interface CoreLike {
  getObject(o: { objectId: string }): Promise<{ object: { content: PromiseLike<Uint8Array> } }>;
  dryRunTransaction(o: { transaction: Uint8Array }): Promise<TxResponseLike>;
  executeTransaction(o: { transaction: Uint8Array; signatures: string[] }): Promise<TxResponseLike>;
  waitForTransaction(o: { digest: string; timeout?: number }): Promise<unknown>;
}

/** A client object `tx.build({ client })` accepts — anything exposing a resolving `.core`.
 *  In the hybrid this is a JSON-RPC SuiClient (its core implements resolveTransactionData). */
type ResolveClient = { core: unknown };

/** The port's signer only needs toSuiAddress(); the adapter also needs real signing. A
 *  @mysten/sui Keypair (e.g. Ed25519Keypair) satisfies this. */
export interface SignerLike extends PaydaySigner {
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
}

const WAIT_TIMEOUT_MS = 60_000;

export class GrpcPaydayClient implements PaydayClient {
  // core = gRPC (dryRun/execute/wait/getObject); resolveClient = JSON-RPC (tx.build resolution only).
  constructor(private readonly core: CoreLike, private readonly resolveClient?: ResolveClient) {}

  private build(tx: Transaction): Promise<Uint8Array> {
    // Resolution (tx.object() refs incl. clock immutability via ABI) happens here via the JSON-RPC
    // resolveClient — gRPC cannot do this in 1.45.2. resolveClient is only optional so unit tests
    // (which stub tx.build) can omit it; a live adapter from makeGrpcPaydayClient always sets it.
    type BuildOpts = NonNullable<Parameters<Transaction["build"]>[0]>;
    return tx.build({ client: this.resolveClient as unknown as BuildOpts["client"] });
  }

  async getCurrentPeriod(payrollId: string): Promise<bigint> {
    const { object } = await this.core.getObject({ objectId: payrollId });
    return decodeCurrentPeriod(await object.content);
  }

  async dryRunTransaction(tx: Transaction): Promise<DryRunResult> {
    const transaction = await this.build(tx);
    return mapDryRun(await this.core.dryRunTransaction({ transaction }));
  }

  async signAndExecute(tx: Transaction, signer: PaydaySigner): Promise<ExecResult> {
    const s = signer as SignerLike;
    const transaction = await this.build(tx);
    const { signature } = await s.signTransaction(transaction);
    return mapExecResult(await this.core.executeTransaction({ transaction, signatures: [signature] }));
  }

  async waitForConfirm(digest: string): Promise<void> {
    // Resolves on finality (existence), not success — safe for a finalized-with-abort tx.
    // Throws loudly only on timeout / not-found; do not swallow.
    await this.core.waitForTransaction({ digest, timeout: WAIT_TIMEOUT_MS });
  }
}

type SuiNetwork = "testnet" | "mainnet" | "devnet" | "localnet";

export function makeGrpcPaydayClient(opts: {
  network: SuiNetwork;
  rpcUrl?: string;
}): GrpcPaydayClient {
  // TRANSITIONAL: one JSON-RPC SuiClient drives everything (core = dryRun/execute/wait/getObject,
  // and itself = tx.build resolution). See header — gRPC upgrade swaps only this function.
  const rpc = new SuiClient({ url: opts.rpcUrl ?? getFullnodeUrl(opts.network) });
  return new GrpcPaydayClient(rpc.core as unknown as CoreLike, rpc as unknown as ResolveClient);
}

/** H1 offline assertion: after build, the clock 0x6 shared input must be mutable:false. */
const CLOCK_ID = "0x0000000000000000000000000000000000000000000000000000000000000006";
export function assertClockImmutable(
  builtInputs: ReadonlyArray<{ Object?: { SharedObject?: { objectId: string; mutable: boolean } } }>,
): void {
  const clock = builtInputs.find((i) => i.Object?.SharedObject?.objectId === CLOCK_ID);
  if (!clock) throw new Error("H1: clock 0x6 not found among shared inputs");
  if (clock.Object!.SharedObject!.mutable !== false) {
    throw new Error("H1 FAIL: clock 0x6 resolved mutable:true — expected immutable (&Clock)");
  }
}
