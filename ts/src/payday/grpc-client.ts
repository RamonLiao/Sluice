import type { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from "@mysten/sui/jsonRpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
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

/** The REAL @mysten/sui@2.x `client.core` (CoreClient) surface the adapter uses — exact v2 shapes,
 *  verified against node_modules/@mysten/sui/dist/client/{core,types}.d.mts. The previous interface
 *  modeled the dead 1.45.2 gRPC shapes; under v2 `rpc.core` (JSONRpcCoreClient extends CoreClient)
 *  provides ALL of these (getObject + waitForTransaction are inherited from the base CoreClient), but
 *  with DIFFERENT param names / return structure — so `as unknown as` previously masked a runtime
 *  TypeError on getCurrentPeriod / waitForConfirm. We normalize these results to TxResponseLike below. */
export interface CoreLike {
  // GetObjectOptions { objectId, include }; with include.content the Object.content is RAW BCS Uint8Array.
  getObject(o: { objectId: string; include: { content: true } }): Promise<{ object: { content: Uint8Array } }>;
  // SimulateTransactionOptions { transaction, include }; result is { $kind, Transaction|FailedTransaction }.
  simulateTransaction(o: { transaction: Uint8Array; include: { effects: true } }): Promise<CoreTxResult>;
  // ExecuteTransactionOptions { transaction, signatures, include }.
  executeTransaction(o: { transaction: Uint8Array; signatures: string[]; include: { effects: true } }): Promise<CoreTxResult>;
  // WaitForTransactionOptions (by digest); resolves on finality, throws on timeout/not-found.
  waitForTransaction(o: { digest: string; timeout?: number }): Promise<unknown>;
}

/** The relevant slice of SuiClientTypes.{Transaction,Simulate}TransactionResult — a $kind-tagged union
 *  whose Transaction/FailedTransaction member carries digest + ExecutionStatus + TransactionEffects.
 *  effects requires include:{effects:true}; error is the structured v2 ExecutionError (object), not a string. */
type CoreExecStatus = { success: boolean; error: { message: string } | null };
type CoreTxBody = {
  digest: string;
  status: CoreExecStatus;
  effects?: { status: CoreExecStatus; gasUsed?: { computationCost: string; storageCost: string; storageRebate: string } };
};
// Exactly one of the two members is present (the v2 $kind-tagged union); both typed optional so stubs
// need not spell out the absent partner. toTxResponseLike() reads whichever is set.
type CoreTxResult = { Transaction?: CoreTxBody; FailedTransaction?: CoreTxBody };

/** Normalize a v2 core tx result into the helper-port TxResponseLike (status+gasUsed the mappers expect).
 *  v2 ExecutionError is an object → flatten to its `.message` string so mapExecResult/mapDryRun are untouched. */
function toTxResponseLike(res: CoreTxResult): TxResponseLike {
  const body = (res.Transaction ?? res.FailedTransaction)!;
  const eff = body.effects;
  const status = eff?.status ?? body.status;
  return {
    transaction: {
      digest: body.digest,
      effects: {
        status: { success: status.success, error: status.success ? null : (status.error?.message ?? null) },
        gasUsed: eff?.gasUsed,
      },
    },
  };
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
    // include:{content:true} → object.content is the RAW BCS Move-struct bytes decodeCurrentPeriod wants.
    const { object } = await this.core.getObject({ objectId: payrollId, include: { content: true } });
    return decodeCurrentPeriod(object.content);
  }

  async dryRunTransaction(tx: Transaction): Promise<DryRunResult> {
    const transaction = await this.build(tx);
    const res = await this.core.simulateTransaction({ transaction, include: { effects: true } });
    return mapDryRun(toTxResponseLike(res));
  }

  async signAndExecute(tx: Transaction, signer: PaydaySigner): Promise<ExecResult> {
    const s = signer as SignerLike;
    const transaction = await this.build(tx);
    const { signature } = await s.signTransaction(transaction);
    const res = await this.core.executeTransaction({ transaction, signatures: [signature], include: { effects: true } });
    return mapExecResult(toTxResponseLike(res));
  }

  async waitForConfirm(digest: string): Promise<void> {
    // Resolves on finality (existence), not success — safe for a finalized-with-abort tx.
    // Throws loudly only on timeout / not-found; do not swallow.
    await this.core.waitForTransaction({ digest, timeout: WAIT_TIMEOUT_MS });
  }
}

type SuiNetwork = "testnet" | "mainnet" | "devnet" | "localnet";

export function makeGrpcPaydayClient(
  opts: { network: SuiNetwork; rpcUrl?: string },
  /** @internal test-only injection — omit in production. Public signature is (opts) → GrpcPaydayClient. */
  _coreOverride?: CoreLike,
): GrpcPaydayClient {
  // TRANSITIONAL: one JSON-RPC SuiClient drives everything (core = simulate/execute/wait/getObject,
  // and itself = tx.build resolution). See header — gRPC upgrade swaps only this function.
  // v2: wire rpc.core (JSONRpcCoreClient, which extends CoreClient). All four methods exist on it —
  // getObject + waitForTransaction are inherited from the base CoreClient. CoreLike now models the
  // REAL v2 shapes, so the cast no longer hides a missing method (the prior dead-shape cast did).
  const rpc = new SuiClient({ url: opts.rpcUrl ?? getFullnodeUrl(opts.network), network: opts.network });
  const core = _coreOverride ?? (rpc.core as unknown as CoreLike);
  return new GrpcPaydayClient(core, rpc as unknown as ResolveClient);
}

/** H1 offline assertion: after `tx.build()`, the resolved clock 0x6 shared input must be mutable:false.
 *  Input shape is `tx.getData().inputs`: { Object: { SharedObject: { objectId, initialSharedVersion,
 *  mutable } } }. normalizeSuiAddress equalizes 0x6 / 0x0…06. */
const CLOCK_ID = normalizeSuiAddress("0x6");
type BuiltInput = { Object?: { SharedObject?: { objectId: string; mutable: boolean } } };
export function assertClockImmutable(builtInputs: ReadonlyArray<BuiltInput>): void {
  const clock = builtInputs.find(
    (i) => i.Object?.SharedObject && normalizeSuiAddress(i.Object.SharedObject.objectId) === CLOCK_ID,
  );
  if (!clock) throw new Error("H1: clock 0x6 not found among shared inputs (was the tx built/resolved?)");
  if (clock.Object!.SharedObject!.mutable !== false) {
    throw new Error("H1 FAIL: clock 0x6 resolved mutable:true — expected immutable (&Clock)");
  }
}
