import { FEEDS, type FeedSpec } from "./feeds.js";
import { rawToFxRate, secToMs, deriveInverse } from "./convert.js";
import { makeHermesFetcher, type FetchRawPrice } from "./hermes.js";
import { UnknownFxPair, type FxPair, type FxScalars } from "./types.js";

export async function getFxScalars(pair: FxPair, fetch: FetchRawPrice = makeHermesFetcher()): Promise<FxScalars> {
  const spec: FeedSpec | undefined = FEEDS[pair];
  if (!spec) throw new UnknownFxPair(`no feed for pair ${pair}`);
  const fx_pair = new TextEncoder().encode(pair);

  const r = await fetch(spec.id);
  const fx_pyth_publish_time_ms = secToMs(r.publishTimeSec);

  if (spec.kind === "direct") {
    return { fx_pair, fx_rate: rawToFxRate(r), fx_pyth_publish_time_ms };
  }
  // inverse: pair = 1 / feed (e.g. JPY/USD = 1 / USD/JPY). publish_time passes through.
  return { fx_pair, fx_rate: deriveInverse(rawToFxRate(r)), fx_pyth_publish_time_ms };
}
