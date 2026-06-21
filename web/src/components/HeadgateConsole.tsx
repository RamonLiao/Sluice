import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { useCallback, useRef, useState } from "react";
import { DappKitPaydayClient } from "../chain/dappkit-payday-client.js";
import { runPayday } from "../payday/run-payday.js";
import { PeriodGateError, type PaydayResult } from "@payroll-flow/orchestrator";
import type { EmployeeRow } from "../chain/payroll-reader.js";
import { dAppKit } from "../providers.js";
import { FlowViz } from "./FlowViz.js";

type Gate = "armed" | "flowing" | "sealed" | "error";

/**
 * N1 invariant: once a chunk at index > 0 has failed, the run is partial and
 * resumeFrom is set. We track this with `partialRun` ref — when true, the full
 * run path is disabled; only the RESUME path is allowed.
 */
export function HeadgateConsole({
  rows,
  onDone,
  ownerCapOk,
}: {
  rows: EmployeeRow[];
  onDone: () => void;
  ownerCapOk: boolean;
}) {
  const account = useCurrentAccount({ dAppKit });
  const client = useCurrentClient({ dAppKit });
  const [gate, setGate] = useState<Gate>("armed");
  const [result, setResult] = useState<PaydayResult | null>(null);
  const [resumeFrom, setResumeFrom] = useState(0);
  const [msg, setMsg] = useState<string>("");
  // N1: true once a mid-run rejection (chunk > 0) has occurred — forces resume-only
  const partialRun = useRef(false);

  // Hold-to-confirm lever: user must hold 1.2s before action fires
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holdPct, setHoldPct] = useState(0);
  const animFrame = useRef<number | null>(null);
  const holdStart = useRef<number | null>(null);
  const HOLD_MS = 1200;

  const cancelHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (animFrame.current) cancelAnimationFrame(animFrame.current);
    holdTimer.current = null;
    animFrame.current = null;
    holdStart.current = null;
    setHoldPct(0);
  }, []);

  const pull = useCallback(async () => {
    // N1 hard guard: if a partial run has occurred, resumeFrom MUST be > 0
    // A stale closure resetting resumeFrom to 0 while partialRun===true would
    // bypass the double-pay guard — block unconditionally here.
    if (partialRun.current && resumeFrom === 0) {
      setMsg("RESUME ONLY — cannot full-retry after a partial run");
      return;
    }
    if (!account) return;
    setGate("flowing");
    setMsg("");

    const signAndExecuteFn = async (tx: Parameters<typeof dAppKit.signAndExecuteTransaction>[0]["transaction"]) => {
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (r.$kind !== "Transaction") throw new Error("wallet/exec failed: " + r.$kind);
      return { digest: r.Transaction.digest };
    };

    const paydayClient = new DappKitPaydayClient(client, signAndExecuteFn);

    try {
      const res = await runPayday({
        rows,
        reader: {} as any,
        client: paydayClient,
        signer: { toSuiAddress: () => account.address },
        resumeFrom,
      });
      setResult(res);

      if (res.completed) {
        setGate("sealed");
        onDone();
      } else {
        // Partial run: chunk was rejected mid-run
        const next = res.nextResumeFrom ?? 0;
        // N1 invariant: if the rejected chunk was NOT chunk 0, lock into resume-only
        if (next > 0) {
          partialRun.current = true;
        }
        setResumeFrom(next);
        setGate("armed");
        setMsg(
          next > 0
            ? `chunk ${next - 1} rejected — RESUME only from chunk ${next}`
            : "chunk 0 rejected — may full-retry",
        );
      }
    } catch (e) {
      if (e instanceof PeriodGateError) {
        setGate("sealed");
        setMsg("PERIOD SEALED");
      } else {
        setGate("error");
        setMsg(String(e));
      }
    }
  }, [account, rows, client, resumeFrom, onDone]);

  const startHold = useCallback(() => {
    if (gate === "flowing" || gate === "sealed") return;
    holdStart.current = Date.now();

    const tick = () => {
      if (!holdStart.current) return;
      const elapsed = Date.now() - holdStart.current;
      const pct = Math.min(100, (elapsed / HOLD_MS) * 100);
      setHoldPct(pct);
      if (pct < 100) {
        animFrame.current = requestAnimationFrame(tick);
      }
    };
    animFrame.current = requestAnimationFrame(tick);

    holdTimer.current = setTimeout(() => {
      setHoldPct(0);
      void pull();
    }, HOLD_MS);
  }, [gate, pull]);

  const sealed = gate === "sealed";
  const flowing = gate === "flowing";
  const leverDisabled = flowing || sealed || !account || !ownerCapOk;

  const netGas =
    result?.receipts.reduce((s, r) => s + (r.gasUsed ?? 0n), 0n) ?? 0n;
  const lastPeriod = result?.receipts.at(-1)?.paidAtPeriod;

  // Label: if partialRun, RESUME is the only label allowed; full-run label otherwise
  const leverLabel = partialRun.current
    ? `RESUME PAYDAY (from chunk ${resumeFrom})`
    : resumeFrom > 0
      ? `RESUME PAYDAY (from chunk ${resumeFrom})`
      : "RUN PAYROLL";

  return (
    <div
      style={{
        borderTop: "1px solid var(--panel-edge)",
        padding: 16,
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <FlowViz active={flowing} />

      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        {/* LEVER — hold-to-confirm */}
        <div style={{ position: "relative", display: "inline-flex", flexDirection: "column", gap: 4 }}>
          <button
            disabled={leverDisabled}
            onMouseDown={startHold}
            onMouseUp={cancelHold}
            onMouseLeave={cancelHold}
            onTouchStart={startHold}
            onTouchEnd={cancelHold}
            aria-label={leverLabel}
            style={{
              background: sealed
                ? "var(--gate-red)"
                : flowing
                  ? "var(--panel-edge)"
                  : "var(--flow)",
              color: "var(--ink)",
              padding: "14px 28px",
              borderRadius: 4,
              fontWeight: 700,
              fontFamily: "var(--mono)",
              letterSpacing: "0.06em",
              cursor: leverDisabled ? "not-allowed" : "pointer",
              border: "none",
              minWidth: 200,
              position: "relative",
              overflow: "hidden",
            }}
          >
            {/* hold-progress fill */}
            {holdPct > 0 && (
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  height: "100%",
                  width: `${holdPct}%`,
                  background: "rgba(0,0,0,0.25)",
                  transition: "none",
                  pointerEvents: "none",
                }}
              />
            )}
            <span style={{ position: "relative", zIndex: 1 }}>
              {flowing ? "FLOWING…" : sealed ? "SEALED" : leverLabel}
            </span>
          </button>
          {!leverDisabled && !flowing && !sealed && (
            <span className="label" style={{ textAlign: "center", fontSize: 10 }}>
              HOLD TO CONFIRM
            </span>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {msg && (
            <span
              className="num"
              role="status"
              style={{
                color: gate === "error" ? "var(--gate-red)" : gate === "sealed" ? "var(--gate-red)" : "var(--mist)",
                fontSize: "0.85em",
              }}
            >
              {msg}
            </span>
          )}
          {result && (
            <span className="num" style={{ color: "var(--chalk)", fontSize: "0.85em" }}>
              period→{lastPeriod?.toString() ?? "—"} · gas {netGas.toString()} MIST ·{" "}
              {result.receipts.filter((r) => r.status === "success").length}/{result.receipts.length} chunks OK
            </span>
          )}
          {!account && (
            <span className="label" style={{ color: "var(--gate-red)" }}>
              wallet not connected
            </span>
          )}
        </div>
      </div>

      {/* Per-chunk receipt log */}
      {result && result.receipts.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            maxHeight: 120,
            overflowY: "auto",
          }}
        >
          {result.receipts.map((r) => (
            <div
              key={r.chunkIndex}
              className="num"
              style={{
                fontSize: "0.78em",
                color:
                  r.status === "success"
                    ? "var(--scallop)"
                    : r.status === "failure"
                      ? "var(--gate-red)"
                      : "var(--mist)",
              }}
            >
              chunk {r.chunkIndex}: {r.status}
              {r.digest ? ` · ${r.digest.slice(0, 12)}…` : ""}
              {r.gasUsed != null ? ` · gas ${r.gasUsed}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
