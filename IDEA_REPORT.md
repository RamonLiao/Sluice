# PayrollFlow

**One-line pitch**: Cross-border Web3 payroll that atomically pays salary, withholds tax, and auto-invests employee allocations in one PTB.

**Problem it solves**: SWIFT payroll is slow, expensive, and disconnected from investing. Web3 employees today manually move funds between payroll, savings, and DeFi.

**Core mechanism**:
- Employer funds a Payroll object with stablecoin.
- Each pay period, PTB executes per-employee: transfer → tax reserve → savings vault → BTC/ETH index → liquid remainder.
- Employees set their own allocation ratios via Cap object.
- Compliance metadata recorded on-chain for audit.

**Why this track**:
- Directly matches HANDBOOK's "salary that streams and earns yield."
- Strong Real-World (50% weight): B2B SaaS revenue model, recurring usage.
- PTB atomic multi-leg payroll is a novel demo.
- Foundation cares about cross-border stablecoin narrative.

**Win probability**: 83/100. Highest "story" score, but hardest to prove "real users" in a hackathon demo — judges can't onboard a company on stage. Penalized vs RedPacket/CreatorFlow on demoability.

**Key risks**:
- Rise / Toku / Bitwage are entrenched — differentiation must be PTB atomicity + on-chain yield.
- Compliance / KYC is a black hole; must scope it out for hackathon.
- B2B sales cycle = no live users by judging day.

**Required Sui primitives**: PTB (multi-leg), Move objects (Payroll, Employee, AllocationCap), stablecoin, Scallop/Navi vaults, zkLogin for employees, Sponsored TX.

**MVP scope**:
1. Employer dashboard: add employees, fund payroll, trigger run.
2. Employee app: set allocation %, view portfolio.
3. PTB executing salary + tax + 2 yield positions atomically.
4. Demo: 3 mock employees paid in one tx, with breakdown visualization.
5. Recorded testimonial from one design-partner company (if obtainable).
