import type { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { PaydayClient, PaydaySigner, DryRunResult, ExecResult } from "./execute-types.js";
import { mapExecResult, mapDryRun, decodeCurrentPeriod, type TxResponseLike } from "./grpc-helpers.js";

/** Minimal client.core surface the adapter uses; the real SuiGrpcClient.core satisfies it. */
export interface CoreLike {
  getObject(o: { objectId: string }): Promise<{ object: { content: PromiseLike<Uint8Array> } }>;
  dryRunTransaction(o: { transaction: Uint8Array }): Promise<TxResponseLike>;
  executeTransaction(o: { transaction: Uint8Array; signatures: string[] }): Promise<TxResponseLike>;
  waitForTransaction(o: { digest: string; timeout?: number }): Promise<unknown>;
}

/** A client object `tx.build({ client })` accepts — anything exposing `.core`. */
type BuildClient = { core: unknown };

/** The port's signer only needs toSuiAddress(); the adapter also needs real signing. A
 *  @mysten/sui Keypair (e.g. Ed25519Keypair) satisfies this. */
export interface SignerLike extends PaydaySigner {
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
}

const WAIT_TIMEOUT_MS = 60_000;

export class GrpcPaydayClient implements PaydayClient {
  private readonly buildClient: BuildClient;

  constructor(private readonly core: CoreLike, buildClient?: BuildClient) {
    this.buildClient = buildClient ?? { core };
  }

  private build(tx: Transaction): Promise<Uint8Array> {
    // `tx.build` resolves tx.object() refs via the core resolver (incl. H1 clock immutability).
    type BuildOpts = NonNullable<Parameters<Transaction["build"]>[0]>;
    return tx.build({ client: this.buildClient as unknown as BuildOpts["client"] });
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

/** Default Sui full-node gRPC-web endpoints. Override via `baseUrl` for a private node. */
const GRPC_ENDPOINTS: Record<SuiNetwork, string> = {
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443",
  localnet: "http://127.0.0.1:9000",
};

export function makeGrpcPaydayClient(opts: {
  network: SuiNetwork;
  baseUrl?: string;
}): GrpcPaydayClient {
  const client = new SuiGrpcClient({
    network: opts.network,
    baseUrl: opts.baseUrl ?? GRPC_ENDPOINTS[opts.network],
  });
  return new GrpcPaydayClient(client.core as unknown as CoreLike, client as unknown as BuildClient);
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
