import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { useState } from "react";
import { buildFund } from "../chain/write-txs.js";
import { TESTNET } from "../config/testnet.js";
import { dAppKit } from "../providers.js";

/** A single coin returned by client.getCoins */
export interface CoinEntry {
  coinObjectId: string;
  balance: string;
}

/**
 * Pick a fund coin that is NOT the wallet gas coin (N2).
 *
 * Sui auto-selects the first coin in the list for gas payment.
 * We exclude coins.data[0] so the fundCoin is always distinct.
 * Throws loudly if no suitable coin can be found.
 */
export function pickFundCoin(coins: CoinEntry[], minBalance: bigint): CoinEntry {
  if (coins.length === 0) {
    throw new Error("FundPanel: no coins found for this account");
  }
  // coins[0] is likely the gas coin; skip it and pick from the rest.
  const candidates = coins.length === 1 ? [] : coins.slice(1);
  const picked = candidates.find((c) => BigInt(c.balance) >= minBalance);
  if (!picked) {
    throw new Error(
      `FundPanel: no distinct fund coin with balance ≥ ${minBalance}. ` +
        `Have ${coins.length} coin(s) but all are either the gas coin or have insufficient balance.`,
    );
  }
  return picked;
}

export function FundPanel({
  funded,
  onDone,
  ownerCapOk,
}: {
  funded: bigint;
  onDone: () => void;
  ownerCapOk: boolean;
}) {
  const account = useCurrentAccount({ dAppKit });
  const client = useCurrentClient({ dAppKit });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Head-pressure: show percentage relative to a reference ceiling.
  // We use a fixed ceiling of 1 SUI (1e9 MIST) so the bar is meaningful
  // even before any fund has been added. Clamp at 100%.
  const CEIL = 1_000_000_000n; // 1 SUI in MIST
  const pct = funded === 0n ? 0 : Math.min(100, Number((funded * 100n) / CEIL));

  async function fund() {
    if (!account) {
      setError("Wallet not connected.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const coins = await client.getCoins({
        owner: account.address,
        coinType: TESTNET.coinType,
      });
      // MIN_FUND: require at least 1 MIST; adjust as needed.
      const MIN_FUND = 1n;
      const fundCoin = pickFundCoin(coins.data, MIN_FUND);

      const tx = buildFund({
        payrollId: TESTNET.payrollId,
        ownerCapId: TESTNET.ownerCapId,
        coinType: TESTNET.coinType,
        coinId: fundCoin.coinObjectId,
      });

      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (result.$kind !== "Transaction") {
        throw new Error("FundPanel: transaction failed or was rejected by wallet");
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--channel)",
        borderRadius: 4,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="label">HEAD PRESSURE</div>

      {/* Fill bar */}
      <div
        role="meter"
        aria-label="Head pressure"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 8,
          background: "var(--ink)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "var(--flow)",
            transition: "width 0.4s ease",
          }}
        />
      </div>

      <span className="num">{funded.toString()} MIST</span>

      {error && (
        <div
          role="alert"
          className="num"
          style={{ color: "var(--gate-red)", fontSize: "0.85em" }}
        >
          {error}
        </div>
      )}

      <button onClick={fund} disabled={busy || !account || !ownerCapOk}>
        {busy ? "FUNDING…" : "FUND"}
      </button>
    </div>
  );
}
