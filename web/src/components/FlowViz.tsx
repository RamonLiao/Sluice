import { motion } from "motion/react";

const STREAMS = [
  { color: "var(--tax)", label: "tax" },
  { color: "var(--liquid)", label: "liquid" },
  { color: "var(--scallop)", label: "scallop" },
  { color: "var(--navi)", label: "navi" },
];

export function FlowViz({ active }: { active: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {/* trunk channel */}
      <motion.div
        initial={{ scaleX: 0 }}
        animate={{ scaleX: active ? 1 : 0 }}
        transition={{ duration: 0.3 }}
        style={{
          height: 6,
          background: "var(--flow)",
          borderRadius: 2,
          transformOrigin: "left",
          marginBottom: 4,
        }}
      />
      {/* 4 fork streams */}
      <div style={{ display: "flex", gap: 6, height: 32 }}>
        {STREAMS.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ scaleY: 0 }}
            animate={{ scaleY: active ? 1 : 0 }}
            transition={{ delay: 0.25 + i * 0.1, duration: 0.28 }}
            title={s.label}
            aria-label={s.label}
            style={{
              flex: 1,
              background: s.color,
              borderRadius: 2,
              transformOrigin: "top",
              opacity: 0.85,
            }}
          />
        ))}
      </div>
    </div>
  );
}
