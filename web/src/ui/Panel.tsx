export function Panel({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid var(--panel-edge)", background: "var(--panel)",
      borderRadius: 4, padding: 16, position: "relative" }}>
      {label && <div className="label" style={{ marginBottom: 8 }}>{label}</div>}
      {children}
    </section>
  );
}
