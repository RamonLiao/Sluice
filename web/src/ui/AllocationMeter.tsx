const COLORS = { tax: "var(--tax)", liquid: "var(--liquid)", scallop: "var(--scallop)", navi: "var(--navi)" };

export function AllocationMeter(
  { taxBps, liquidBps, scallopBps, naviBps }: { taxBps: number; liquidBps: number; scallopBps: number; naviBps: number },
) {
  const segs: Array<[keyof typeof COLORS, number]> = [
    ["tax", taxBps], ["liquid", liquidBps], ["scallop", scallopBps], ["navi", naviBps],
  ];
  return (
    <div style={{ display: "flex", height: 6, width: "100%", borderRadius: 2, overflow: "hidden" }}>
      {segs.map(([k, bps]) => (
        <div key={k} data-seg={k} style={{ width: `${bps / 100}%`, background: COLORS[k] }} />
      ))}
    </div>
  );
}
