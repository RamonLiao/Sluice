import type { Transaction } from "@mysten/sui/transactions";
import type { FxPair, FxScalars } from "../fx/types.js";

/** Provisional object-mutation budget per PTB (spec §13); Phase C calibrates the real ceiling. */
export const MAX_BATCH = 50;

/** A payee for one payday: address + the currency pair their compliance event is denominated in. */
export interface PaydayEmployee {
  addr: string;   // 0x-prefixed Sui address
  pair: FxPair;
}

/** Pinned on-chain handles + type tag the builder needs. All resolution deferred to Phase B. */
export interface PaydayConfig {
  packageId: string;
  coinType: string;   // T type arg for pay_one<T> (full coin type tag)
  payrollId: string;
  ownerCapId: string;
  escrowId: string;
  scallopId: string;  // canonical mainnet vault ID — pinned (spec §2)
  naviId: string;
  clockId: string;    // 0x6
}

export interface PaydayChunk {
  employees: string[];      // addresses in this chunk, in order
  hasBeginPeriod: boolean;  // true only for chunk[0]
}

export interface PaydayPlan {
  transactions: Transaction[];
  chunks: PaydayChunk[];
}

/** Re-export for callers assembling the per-pair scalar map. */
export type { FxPair, FxScalars };

export class DuplicatePayee extends Error {}      // same address twice in one buildPayday
export class MissingFxScalars extends Error {}    // employee.pair absent from fxByPair
export class FxPairLabelMismatch extends Error {} // fxByPair scalars' fx_pair bytes != employee.pair
