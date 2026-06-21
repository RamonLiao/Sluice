import type { EmployeeRow } from "../chain/payroll-reader.js";
import { AllocationMeter } from "./AllocationMeter.js";

function statusDot(r: EmployeeRow): { background: string; border: string } {
  if (r.lastPaidPeriod === 0n) {
    return { background: "transparent", border: "1px solid var(--mist)" };
  }
  const color = r.active ? "var(--flow)" : "var(--mist)";
  return { background: color, border: `1px solid ${color}` };
}

export function Roster({
  rows,
  onSelect,
}: {
  rows: EmployeeRow[];
  onSelect: (r: EmployeeRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="label" style={{ padding: 24 }}>
        NO HEAD PRESSURE — FUND TO ARM
      </div>
    );
  }

  return (
    <div style={{ width: "100%" }}>
      {rows.map((r) => {
        const dot = statusDot(r);
        return (
          <button
            key={r.addr}
            onClick={() => onSelect(r)}
            style={{
              display: "grid",
              gridTemplateColumns: "16px 1fr 120px 160px",
              gap: 12,
              alignItems: "center",
              width: "100%",
              height: 44,
              background: "none",
              border: "none",
              borderBottom: "1px solid var(--panel-edge)",
              color: "var(--chalk)",
              textAlign: "left",
              cursor: "pointer",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                display: "inline-block",
                background: dot.background,
                border: dot.border,
              }}
            />
            <span className="num">
              {r.addr.slice(0, 10)}…{r.addr.slice(-4)}
            </span>
            <span className="num" style={{ textAlign: "right" }}>
              {r.gross.toString()}
            </span>
            <AllocationMeter
              taxBps={r.withholdingBps}
              liquidBps={r.liquidBps}
              scallopBps={r.scallopBps}
              naviBps={r.naviBps}
            />
          </button>
        );
      })}
    </div>
  );
}
