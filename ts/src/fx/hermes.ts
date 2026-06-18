import { HermesClient } from "@pythnetwork/hermes-client";
import { FxFeedUnavailable, type RawPythPrice } from "./types.js";

export type FetchRawPrice = (feedId: string) => Promise<RawPythPrice>;

const HERMES_URL = "https://hermes.pyth.network";

// Verified against @pythnetwork/hermes-client@3.1.0:
//   getLatestPriceUpdates(ids): Promise<PriceUpdate>
//   PriceUpdate.parsed: ParsedPriceUpdate[]; each .price = { price: string, expo: number, publish_time: number }
/** Live fetcher. */
export function makeHermesFetcher(client = new HermesClient(HERMES_URL)): FetchRawPrice {
  return async (feedId: string): Promise<RawPythPrice> => {
    const res = await client.getLatestPriceUpdates([feedId]);
    const p = res?.parsed?.[0]?.price;
    if (!p) throw new FxFeedUnavailable(`no Hermes price for feed ${feedId}`);
    return {
      price: BigInt(p.price),
      expo: Number(p.expo),
      publishTimeSec: BigInt(p.publish_time),
    };
  };
}
