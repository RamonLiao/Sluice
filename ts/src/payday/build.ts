import type { FxScalars } from "../fx/types.js";
import {
  type PaydayEmployee,
  DuplicatePayee,
  MissingFxScalars,
  FxPairLabelMismatch,
} from "./types.js";

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
