/**
 * App.tsx — Headgate layout
 *
 * Layout: Rail (left) | Main (ConnectBar + FundPanel + Roster + HeadgateConsole) | GateConfigDrawer (right, contextual)
 *
 * Owner-cap write gate:
 *   - On account connect, findOwnerCap() checks TESTNET.ownerCapId vs wallet owned objects.
 *   - ownerCapOk === true only when the connected wallet holds the verified OwnerCap.
 *   - GateConfigDrawer receives ownerCapId only when ownerCapOk; otherwise drawer is not shown.
 *   - HeadgateConsole internally checks account existence.
 *
 * refetch after each tx: queryClient.invalidateQueries(["payroll"]).
 */

import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { findOwnerCap } from "./chain/owner-cap.js";
import { ConnectBar, type CreatedIds } from "./components/ConnectBar.js";
import { FundPanel } from "./components/FundPanel.js";
import { GateConfigDrawer } from "./components/GateConfigDrawer.js";
import { HeadgateConsole } from "./components/HeadgateConsole.js";
import { Rail } from "./components/Rail.js";
import { TESTNET } from "./config/testnet.js";
import { usePayrollState } from "./hooks/usePayrollState.js";
import { dAppKit } from "./providers.js";
import { Roster } from "./ui/Roster.js";
import type { EmployeeRow } from "./chain/payroll-reader.js";

export default function App() {
  const account = useCurrentAccount({ dAppKit });
  const client = useCurrentClient({ dAppKit });
  const queryClient = useQueryClient();

  // Owner-cap gate: true when wallet holds the verified OwnerCap
  const [ownerCapOk, setOwnerCapOk] = useState(false);

  // Currently selected employee (or "new") for the drawer
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeRow | "new" | null>(null);

  // Active payroll IDs — initialized from TESTNET constants; updated after create_payroll
  const [payrollId, setPayrollId] = useState(TESTNET.payrollId);
  const [ownerCapId, setOwnerCapId] = useState(TESTNET.ownerCapId);

  const { data, refetch } = usePayrollState();
  const rows = data?.rows ?? [];
  const period = data?.currentPeriod ?? 0n;
  const funded = data?.funded ?? 0n;

  // Re-check owner cap whenever account or payrollId changes
  useEffect(() => {
    if (!account) {
      setOwnerCapOk(false);
      return;
    }
    let cancelled = false;
    findOwnerCap(client, account.address, payrollId, ownerCapId)
      .then((found) => {
        if (!cancelled) setOwnerCapOk(found !== null);
      })
      .catch(() => {
        if (!cancelled) setOwnerCapOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account, client, payrollId, ownerCapId]);

  function handleCreated(ids: CreatedIds) {
    setPayrollId(ids.payrollId);
    setOwnerCapId(ids.ownerCapId);
    void queryClient.invalidateQueries({ queryKey: ["payroll"] });
  }

  function handleTxDone() {
    void refetch();
  }

  return (
    <div
      data-testid="app-root"
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--ink)",
        color: "var(--chalk)",
      }}
    >
      {/* Left rail */}
      <Rail ownerCapOk={ownerCapOk} period={period} />

      {/* Main area */}
      <div
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        {/* Top bar: connect + new payroll */}
        <ConnectBar onCreated={handleCreated} />

        {/* Scrollable content */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {/* Head pressure */}
          <FundPanel funded={funded} onDone={handleTxDone} ownerCapOk={ownerCapOk} />

          {/* Roster */}
          <div
            style={{
              background: "var(--panel)",
              borderRadius: 4,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                borderBottom: "1px solid var(--panel-edge)",
              }}
            >
              <span className="label">ROSTER</span>
              {ownerCapOk && (
                <button
                  aria-label="add employee"
                  onClick={() => setSelectedEmployee("new")}
                  style={{ fontSize: 11 }}
                >
                  + ADD EMPLOYEE
                </button>
              )}
            </div>
            <Roster rows={rows} onSelect={setSelectedEmployee} />
          </div>

          {/* Headgate console */}
          <HeadgateConsole rows={rows} onDone={handleTxDone} ownerCapOk={ownerCapOk} />
        </div>
      </div>

      {/* Right drawer — contextual, only when ownerCapOk */}
      {selectedEmployee !== null && ownerCapOk && (
        <GateConfigDrawer
          employee={selectedEmployee}
          ownerCapId={ownerCapId}
          onClose={() => setSelectedEmployee(null)}
          onDone={() => {
            setSelectedEmployee(null);
            handleTxDone();
          }}
        />
      )}
    </div>
  );
}
