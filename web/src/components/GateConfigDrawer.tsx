import { useState } from "react";
import type { EmployeeRow } from "../chain/payroll-reader.js";
import {
  buildAddEmployee,
  buildSetGross,
} from "../chain/write-txs.js";
import { dAppKit } from "../providers.js";
import { TESTNET } from "../config/testnet.js";
// Note: RatioSliders / set_ratios is employee-side only (#3 Employee PWA).
// AllocationCap is transferred to the employee on add_employee; the employer
// never holds it, so ratio-setting is not a valid employer action.

async function execTx(tx: import("@mysten/sui/transactions").Transaction) {
  const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
  if (result.$kind !== "Transaction") {
    throw new Error("wallet/exec failed");
  }
  return result.Transaction.digest;
}

export function GateConfigDrawer({
  employee,
  ownerCapId,
  onClose,
  onDone,
}: {
  employee: EmployeeRow | "new";
  ownerCapId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  // add_employee form
  const [newAddr, setNewAddr] = useState("");
  const [jurisdiction, setJurisdiction] = useState("US");
  const [gross, setGross] = useState("0");
  const [withholdingBps, setWithholdingBps] = useState("0");

  // set_gross form
  const [newGross, setNewGross] = useState(
    employee !== "new" ? String(employee.gross) : "0",
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddEmployee() {
    const jurisdictionBytes = new TextEncoder().encode(
      jurisdiction.slice(0, 2).toUpperCase(),
    );
    const tx = buildAddEmployee({
      payrollId: TESTNET.payrollId,
      ownerCapId,
      coinType: TESTNET.coinType,
      employee: newAddr,
      jurisdiction: jurisdictionBytes,
      gross: BigInt(gross),
      withholdingBps: Number(withholdingBps),
    });
    await execTx(tx);
  }

  async function handleSetGross() {
    if (employee === "new") return;
    const tx = buildSetGross({
      payrollId: TESTNET.payrollId,
      ownerCapId,
      coinType: TESTNET.coinType,
      employee: employee.addr,
      gross: BigInt(newGross),
    });
    await execTx(tx);
  }

  return (
    <aside
      style={{
        position: "fixed",
        right: 0,
        top: 0,
        height: "100%",
        width: 360,
        borderLeft: "1px solid var(--panel-edge)",
        background: "var(--panel)",
        padding: 16,
        overflowY: "auto",
        zIndex: 100,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <span className="label">GATE CONFIG</span>
        <button onClick={onClose} disabled={busy}>
          ✕
        </button>
      </div>

      {error && (
        <div style={{ color: "var(--gate-red)", marginBottom: 8, fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* ADD EMPLOYEE — only when employee === "new" */}
      {employee === "new" && (
        <section style={{ marginBottom: 24 }}>
          <div className="label" style={{ marginBottom: 8 }}>
            ADD EMPLOYEE
          </div>
          <label style={{ display: "block", marginBottom: 4 }}>
            <span className="label">address</span>
            <input
              type="text"
              value={newAddr}
              onChange={(e) => setNewAddr(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 4 }}>
            <span className="label">jurisdiction (2-letter)</span>
            <input
              type="text"
              maxLength={2}
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value.toUpperCase())}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 4 }}>
            <span className="label">gross (MIST)</span>
            <input
              type="number"
              value={gross}
              onChange={(e) => setGross(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            <span className="label">withholding bps</span>
            <input
              type="number"
              value={withholdingBps}
              onChange={(e) => setWithholdingBps(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </label>
          <button
            onClick={() => run(handleAddEmployee)}
            disabled={busy || !newAddr}
          >
            {busy ? "…" : "STAGE ADD EMPLOYEE"}
          </button>
        </section>
      )}

      {/* SET GROSS — only when editing existing employee */}
      {employee !== "new" && (
        <section style={{ marginBottom: 24 }}>
          <div className="label" style={{ marginBottom: 8 }}>
            SET GROSS
          </div>
          <div style={{ fontSize: 11, color: "var(--mist)", marginBottom: 4 }}>
            {employee.addr}
          </div>
          <label style={{ display: "block", marginBottom: 8 }}>
            <span className="label">gross (MIST)</span>
            <input
              type="number"
              value={newGross}
              onChange={(e) => setNewGross(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </label>
          <button onClick={() => run(handleSetGross)} disabled={busy}>
            {busy ? "…" : "STAGE SET GROSS"}
          </button>
        </section>
      )}

    </aside>
  );
}
