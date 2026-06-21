export function Rail({
  ownerCapOk,
  period,
}: {
  ownerCapOk: boolean;
  period: bigint;
}) {
  return (
    <nav
      style={{
        width: 200,
        borderRight: "1px solid var(--panel-edge)",
        padding: 16,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="label">SLUICE</div>

      <div className="label" style={{ marginTop: 16 }}>
        OWNER CAP
      </div>
      <span
        role="status"
        aria-label={ownerCapOk ? "owner cap verified" : "owner cap not verified"}
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: ownerCapOk ? "var(--flow)" : "var(--gate-red)",
          display: "inline-block",
        }}
      />

      <div className="label" style={{ marginTop: 16 }}>
        PERIOD
      </div>
      <div className="num" style={{ fontSize: 28 }}>
        {period.toString().padStart(4, "0")}
      </div>
    </nav>
  );
}
