import { AllocationMeter } from "../ui/AllocationMeter.js";

export interface Ratios {
  liquidBps: number;
  scallopBps: number;
  naviBps: number;
}

export function ratioError(r: Ratios): string | null {
  return r.liquidBps + r.scallopBps + r.naviBps === 10000
    ? null
    : "ratios must sum to 10000 bps";
}

export function RatioSliders({
  value,
  onChange,
}: {
  value: Ratios;
  onChange: (r: Ratios) => void;
}) {
  const err = ratioError(value);
  const slider = (k: keyof Ratios, color: string) => (
    <label key={k} style={{ display: "block", marginBottom: 8 }}>
      <span className="label" style={{ color, marginRight: 8 }}>
        {k}
      </span>
      <input
        type="range"
        min={0}
        max={10000}
        step={100}
        value={value[k]}
        onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) })}
      />
      <span className="num" style={{ marginLeft: 8 }}>
        {value[k]}
      </span>
    </label>
  );
  return (
    <div>
      {slider("liquidBps", "var(--liquid)")}
      {slider("scallopBps", "var(--scallop)")}
      {slider("naviBps", "var(--navi)")}
      <AllocationMeter
        taxBps={0}
        liquidBps={value.liquidBps}
        scallopBps={value.scallopBps}
        naviBps={value.naviBps}
      />
      <div
        className="num"
        style={{ color: err ? "var(--gate-red)" : "var(--mist)", marginTop: 4 }}
      >
        {err ?? "balanced"}
      </div>
    </div>
  );
}
