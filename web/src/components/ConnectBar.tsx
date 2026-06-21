/**
 * ConnectBar.tsx — v2 dapp-kit API
 *
 * create_payroll discovery uses the `objectTypes` + `effects.changedObjects` path
 * (v2 TransactionInclude) instead of the v1 `objectChanges` field which does not exist.
 *
 * Strategy:
 *   1. Call signAndExecuteTransaction with { effects: true, objectTypes: true }.
 *   2. From result.Transaction.effects.changedObjects, filter idOperation === 'Created'.
 *   3. Look up each created objectId in result.Transaction.objectTypes (Record<string,string>)
 *      to get its Move type.
 *   4. Reuse pickCreatedObjects-style substring matching on the fetched types.
 */
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { useState } from "react";
import { buildCreatePayroll } from "../chain/write-txs.js";
import { TESTNET } from "../config/testnet.js";
import { dAppKit } from "../providers.js";

export interface CreatedIds {
  payrollId: string;
  ownerCapId: string;
  escrowId: string;
}

function pickFromTypesMap(
  types: Record<string, string>,
  createdIds: string[],
): CreatedIds {
  const find = (frag: string): string => {
    const id = createdIds.find((id) => (types[id] ?? "").includes(frag));
    if (!id) throw new Error(`create_payroll: no created object matching '${frag}'`);
    return id;
  };
  return {
    payrollId: find("::payroll::Payroll<"),
    ownerCapId: find("::payroll::PayrollOwnerCap"),
    escrowId: find("::escrow::TaxEscrow<"),
  };
}

export function ConnectBar({
  onCreated,
}: {
  onCreated: (ids: CreatedIds) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const tx = buildCreatePayroll(TESTNET.coinType);
      const result = await dAppKit.signAndExecuteTransaction({
        transaction: tx,
        // v2 TransactionInclude: request effects + objectTypes map
        include: { effects: true, objectTypes: true },
      } as Parameters<typeof dAppKit.signAndExecuteTransaction>[0]);

      if (result.$kind !== "Transaction") {
        throw new Error("create_payroll: transaction rejected by wallet");
      }

      const effects = result.Transaction.effects;
      const objectTypes = result.Transaction.objectTypes as Record<string, string> | undefined;

      if (!effects || !objectTypes) {
        throw new Error(
          "create_payroll: effects/objectTypes not returned — cannot discover created objects",
        );
      }

      // Extract IDs of objects created by this tx
      const createdIds = effects.changedObjects
        .filter((c) => c.idOperation === "Created")
        .map((c) => c.objectId);

      if (createdIds.length === 0) {
        throw new Error("create_payroll: no created objects in effects");
      }

      const ids = pickFromTypesMap(objectTypes, createdIds);
      onCreated(ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "8px 16px",
        borderBottom: "1px solid var(--panel-edge)",
      }}
    >
      <ConnectButton instance={dAppKit} />
      <button onClick={create} disabled={busy} aria-label="create new payroll">
        {busy ? "CREATING…" : "NEW PAYROLL"}
      </button>
      {error && (
        <span
          role="alert"
          className="num"
          style={{ color: "var(--gate-red)", fontSize: "0.8em" }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
