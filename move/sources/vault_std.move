/// The vault seam (D1/D2). Move has no traits, so the "interface" is a documented
/// function-shape contract each vault module must satisfy (see spec §3.2), plus the
/// shared liveness helper below. `allocation::route()` depends only on these shapes,
/// never on a concrete vault's internals — so the mainnet swap is a body replacement
/// of the mock module while its signature stays fixed.
module payroll_flow::vault_std;

/// Raised by `assert_active` when a vault is paused. `route()` (D8) is expected to
/// catch outage *before* calling a vault by reading its `active` flag, so this is the
/// last-line guard for direct vault calls (e.g. employee withdrawals), not the payday path.
const EVaultInactive: u64 = 100;

/// Every vault exposes a liveness flag the router / withdrawer reads for D8 fallback.
/// Kept in the seam so both mock models (and future mainnet adapters) abort identically.
public fun assert_active(active: bool) {
    assert!(active, EVaultInactive);
}
