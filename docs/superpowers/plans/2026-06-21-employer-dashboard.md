# Sluice Employer Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Sluice employer dashboard (foundation #0 + dashboard #1) — connect wallet, full employee CRUD, fund, and one-click atomic Run Payroll against testnet, reusing the verified `@payroll-flow/orchestrator`.

**Architecture:** New `web/` Vite+React package in a pnpm workspace imports the orchestrator. A `PayrollReader` port reads the on-chain `employees` Table via dynamic fields; a `DappKitPaydayClient` implements the existing `PaydayClient` port by signing each chunk through the browser wallet (never pre-building — preserves the executor's per-chunk safety). UI follows the "Headgate" control-room design.

**Tech Stack:** Vite, React 18, TypeScript (strict), `@mysten/dapp-kit-react`, `@mysten/sui@1.45.2` (pinned, matches orchestrator), `@tanstack/react-query`, `motion` (animation), vitest.

## Global Constraints

- Pin `@mysten/sui@1.45.2` in `web/` (must match orchestrator; do NOT bump to v2).
- Read path = JSON-RPC `SuiClient` (orchestrator is JSON-RPC; gRPC unusable on testnet 1.45.2). Keep behind `PayrollReader` port for future GraphQL/gRPC swap.
- All on-chain `u64` (gross, current_period, last_paid_period, periods) parsed with `BigInt`, NEVER `Number`.
- `DappKitPaydayClient` MUST build→sign→execute→waitForConfirm strictly per chunk; NEVER batch-build all chunks (C1: stale owned-input versions → equivocation).
- Run Payroll MUST pass `expectedPeriod` (read `current_period` immediately before) and `resumeFrom`; on resume chunk[0] is skipped not rebuilt (C2: non-idempotent `begin_period` → double-pay).
- Owner-cap gate is two-way: connected addr owns a `PayrollOwnerCap` with `payroll_id == selected` AND cap object id `== Payroll.owner_cap_id` (I4).
- Money/bps/gas/address/period figures rendered in tabular monospace. Reject AI aesthetic per spec "Anti-AI-slop rules".
- Four allocation colors are global+fixed: tax `#E2B13C`, liquid `#5BC8F5`, scallop `#7AE08B`, navi `#F2784B`.
- Testnet handles come from `ts/testnet.json` (committed). coinType `0x2::sui::SUI`.

---

### Task 1: pnpm workspace + orchestrator exports

**Files:**
- Create: `pnpm-workspace.yaml` (repo root of the 03-payroll-flow project)
- Modify: `ts/package.json` (add `exports` + `name` already present)
- Create: `ts/src/index.ts` (public barrel)

**Interfaces:**
- Produces: `@payroll-flow/orchestrator` importable in `web/` exposing `buildPayday`, `executePayday`, `assertPeriodGate`, `getFxScalars`, all payday/fx types, `MAX_BATCH`, and error classes.

- [ ] **Step 1: Create the barrel** `ts/src/index.ts`

```ts
export * from "./payday/types.js";
export * from "./payday/execute-types.js";
export { buildPayday, assertPaydayInputs } from "./payday/build.js";
export { executePayday, assertPeriodGate } from "./payday/execute.js";
export { getFxScalars } from "./fx/pyth-client.js";
export * from "./fx/types.js";
export { FEEDS } from "./fx/feeds.js";
```

- [ ] **Step 2: Add `exports` to `ts/package.json`**

Add to the JSON (alongside `"type": "module"`):

```json
"exports": { ".": "./src/index.ts" }
```

(Source-level export — `web/` is bundled by Vite which transpiles TS, so no build step needed.)

- [ ] **Step 3: Create `pnpm-workspace.yaml` at project root**

```yaml
packages:
  - ts
  - web
```

- [ ] **Step 4: Verify orchestrator still type-checks**

Run: `cd ts && pnpm build`
Expected: PASS (tsc --noEmit clean).

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml ts/package.json ts/src/index.ts
git commit -m "feat(web): #9 pnpm workspace + orchestrator public barrel"
```

---

### Task 2: web/ Vite scaffold + providers + testnet config

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`
- Create: `web/src/main.tsx`, `web/src/App.tsx`
- Create: `web/src/config/testnet.ts`
- Create: `web/src/providers.tsx`

**Interfaces:**
- Produces: `TESTNET` config object `{ packageId, payrollId, escrowId, ownerCapId, scallopId, naviId, clockId, coinType, network }`; `<Providers>` wrapping SuiClientProvider + WalletProvider + QueryClientProvider; running dev server.

- [ ] **Step 1: Scaffold web package** — create `web/package.json`

```json
{
  "name": "@payroll-flow/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mysten/dapp-kit-react": "^0.2.0",
    "@mysten/sui": "1.45.2",
    "@payroll-flow/orchestrator": "workspace:*",
    "@tanstack/react-query": "^5.0.0",
    "motion": "^11.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^6.0.3",
    "vite": "^6.0.0",
    "vitest": "^4.1.9"
  }
}
```

> Verify the actual published `@mysten/dapp-kit-react` version with `pnpm view @mysten/dapp-kit-react version` before pinning; use the latest 0.x that depends on `@mysten/sui@^1.45`. If dapp-kit-react requires sui v2, fall back to the older `@mysten/dapp-kit` (v1-compatible) and adjust imports in Task 14.

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({ plugins: [react()] });
```

- [ ] **Step 4: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sluice</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `web/src/config/testnet.ts`** (mirror `ts/testnet.json`, clock 0x6 added)

```ts
export const TESTNET = {
  network: "testnet" as const,
  packageId: "0xec5547fb4757de7b176f5df0c237ed0b6666de801aab4b3830e67f4a393c749b",
  payrollId: "0x5c50dcf1cb34933a473ac8c5a8eb4e1409d50d5de1b1811bc82678ee8bf023b8",
  escrowId: "0xc68e42f6833891398f5596ff1ae8788da285bcdd848355e476959c346d887793",
  ownerCapId: "0x8a9b1539e70e22ceafbda0a8ac9d162267a0a86dd133b2a74a68fa1873073f27",
  scallopId: "0x2e7e39b5d48d8d7c53bc2b746f78a9ccb9c57d81dbadda7f273b918cac285c21",
  naviId: "0xffbd94cd7921ca2e8cd45d4cb8ed340318ea666b7da80d615af50048f0e51ee1",
  clockId: "0x6",
  coinType: "0x2::sui::SUI",
};
```

- [ ] **Step 6: Create `web/src/providers.tsx`**

```tsx
import { SuiClientProvider, WalletProvider, createNetworkConfig } from "@mysten/dapp-kit-react";
import { getFullnodeUrl } from "@mysten/sui/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { networkConfig } = createNetworkConfig({ testnet: { url: getFullnodeUrl("testnet") } });
const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
```

> Exact provider import names/paths depend on the resolved dapp-kit-react version — confirm against `node_modules/@mysten/dapp-kit-react` `.d.ts` (per lessons: verify installed version, don't trust docs).

- [ ] **Step 7: Create `web/src/App.tsx` and `web/src/main.tsx`** (placeholder app)

```tsx
// App.tsx
export default function App() {
  return <main data-testid="app-root">Sluice</main>;
}
```

```tsx
// main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Providers } from "./providers.js";
import App from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers><App /></Providers>
  </StrictMode>,
);
```

- [ ] **Step 8: Install + verify dev server boots**

Run: `pnpm install` (project root) then `cd web && pnpm dev`
Expected: Vite serves; opening the URL renders "Sluice" with no console errors.

- [ ] **Step 9: Commit**

```bash
git add web pnpm-lock.yaml
git commit -m "feat(web): #9 Vite+React+dapp-kit scaffold, testnet config, providers"
```

---

### Task 3: PayrollReader port + ChainPayrollReader (dynamic-field decode)

**Files:**
- Create: `web/src/chain/payroll-reader.ts`
- Test: `web/src/chain/payroll-reader.test.ts`
- Create fixture: `web/src/chain/__fixtures__/employee-field.json` (a REAL captured `getDynamicFieldObject` response — see Step 0)

**Interfaces:**
- Consumes: `SuiClient` (read-only).
- Produces:
  ```ts
  export interface EmployeeRow {
    addr: string; jurisdiction: Uint8Array; gross: bigint; withholdingBps: number;
    liquidBps: number; scallopBps: number; naviBps: number;
    pendingFromPeriod: bigint | null; lastPaidPeriod: bigint; active: boolean;
  }
  export interface PayrollReader {
    listEmployees(payrollId: string): Promise<EmployeeRow[]>;
    currentPeriod(payrollId: string): Promise<bigint>;
    ownerCapId(payrollId: string): Promise<string>;
  }
  export class ChainPayrollReader implements PayrollReader { constructor(client: SuiClient) }
  ```

- [ ] **Step 0: Capture a real fixture** — run against testnet to get the true wire shape (lessons: never hand-mock SDK shapes).

Run (from `ts/`, an employee addr from testnet.json):
```bash
cd ts && npx tsx -e "import {SuiClient,getFullnodeUrl} from '@mysten/sui/client'; const c=new SuiClient({url:getFullnodeUrl('testnet')}); const p='0x5c50dcf1cb34933a473ac8c5a8eb4e1409d50d5de1b1811bc82678ee8bf023b8'; (async()=>{const o=await c.getObject({id:p,options:{showContent:true}}); const tbl=(o.data.content as any).fields.employees.fields.id.id; const df=await c.getDynamicFields({parentId:tbl}); console.log(JSON.stringify(df,null,2)); const first=await c.getDynamicFieldObject({parentId:tbl,name:df.data[0].name}); console.log(JSON.stringify(first,null,2));})()"
```
Save the second object's JSON to `web/src/chain/__fixtures__/employee-field.json`. Note the nesting: Table value is a `Field<address,EmployeeRecord>` → record under `.data.content.fields.value.fields`; `allocation` under `.value.fields.allocation.fields`; `pending` is a Move `Option` → `{ fields: { ... } }` or null; `jurisdiction` is a number[] byte array; `gross`/`last_paid_period` are string u64.

> If testnet RPC fields differ from the assumptions above, the fixture is the source of truth — adjust the decoder (Step 3) to match the captured JSON, not the other way around.

- [ ] **Step 1: Write the failing decode test** `payroll-reader.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { decodeEmployeeField } from "./payroll-reader.js";
import fixture from "./__fixtures__/employee-field.json";

describe("decodeEmployeeField", () => {
  it("decodes nested Field<addr,EmployeeRecord> into EmployeeRow with bigint u64", () => {
    const row = decodeEmployeeField(fixture as any);
    expect(typeof row.gross).toBe("bigint");
    expect(typeof row.lastPaidPeriod).toBe("bigint");
    expect(row.liquidBps + row.scallopBps + row.naviBps).toBe(10000);
    expect(row.addr).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row.withholdingBps).toBeTypeOf("number");
    expect(row.jurisdiction).toBeInstanceOf(Uint8Array);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd web && pnpm test payroll-reader`
Expected: FAIL — `decodeEmployeeField is not a function`.

- [ ] **Step 3: Implement `payroll-reader.ts`** (decoder paths matched to the captured fixture)

```ts
import type { SuiClient } from "@mysten/sui/client";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export interface EmployeeRow {
  addr: string; jurisdiction: Uint8Array; gross: bigint; withholdingBps: number;
  liquidBps: number; scallopBps: number; naviBps: number;
  pendingFromPeriod: bigint | null; lastPaidPeriod: bigint; active: boolean;
}
export interface PayrollReader {
  listEmployees(payrollId: string): Promise<EmployeeRow[]>;
  currentPeriod(payrollId: string): Promise<bigint>;
  ownerCapId(payrollId: string): Promise<string>;
}

// `obj` = a getDynamicFieldObject response. Adjust the field path to the captured fixture.
export function decodeEmployeeField(obj: any): EmployeeRow {
  const v = obj.data.content.fields.value.fields;          // Field<K,V> → V
  const a = v.allocation.fields;
  const pending = a.pending ? a.pending.fields ?? a.pending : null;
  return {
    addr: normalizeSuiAddress(v.employee),
    jurisdiction: Uint8Array.from(v.jurisdiction as number[]),
    gross: BigInt(v.gross),
    withholdingBps: Number(v.withholding_bps),
    liquidBps: Number(a.liquid_bps),
    scallopBps: Number(a.scallop_usdc_bps),
    naviBps: Number(a.navi_btc_bps),
    pendingFromPeriod: pending ? BigInt(pending.effective_from_period) : null,
    lastPaidPeriod: BigInt(v.last_paid_period),
    active: Boolean(v.active),
  };
}

export class ChainPayrollReader implements PayrollReader {
  constructor(private readonly client: SuiClient) {}

  async listEmployees(payrollId: string): Promise<EmployeeRow[]> {
    const obj = await this.client.getObject({ id: payrollId, options: { showContent: true } });
    const tableId = (obj.data!.content as any).fields.employees.fields.id.id;
    const rows: EmployeeRow[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.client.getDynamicFields({ parentId: tableId, cursor });
      for (const f of page.data) {
        const field = await this.client.getDynamicFieldObject({ parentId: tableId, name: f.name });
        rows.push(decodeEmployeeField(field));
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
    return rows;
  }

  async currentPeriod(payrollId: string): Promise<bigint> {
    const obj = await this.client.getObject({ id: payrollId, options: { showContent: true } });
    return BigInt((obj.data!.content as any).fields.current_period);
  }

  async ownerCapId(payrollId: string): Promise<string> {
    const obj = await this.client.getObject({ id: payrollId, options: { showContent: true } });
    return normalizeSuiAddress((obj.data!.content as any).fields.owner_cap_id);
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd web && pnpm test payroll-reader`
Expected: PASS.

- [ ] **Step 5: Live smoke (manual, real chain)** — list the 3 testnet employees.

Run: `cd web && npx tsx -e "import {SuiClient,getFullnodeUrl} from '@mysten/sui/client'; import {ChainPayrollReader} from './src/chain/payroll-reader.ts'; const r=new ChainPayrollReader(new SuiClient({url:getFullnodeUrl('testnet')})); r.listEmployees('0x5c50dcf1cb34933a473ac8c5a8eb4e1409d50d5de1b1811bc82678ee8bf023b8').then(rows=>console.log(rows.length, rows.map(x=>[x.addr.slice(0,8),x.gross,x.liquidBps]).join('\n')))"`
Expected: 3 rows, gross as bigint, bps summing 10000.

- [ ] **Step 6: Commit**

```bash
git add web/src/chain
git commit -m "feat(web): #9 ChainPayrollReader — dynamic-field decode, pagination, BigInt u64"
```

---

### Task 4: Owner-cap two-way gate

**Files:**
- Create: `web/src/chain/owner-cap.ts`
- Test: `web/src/chain/owner-cap.test.ts`

**Interfaces:**
- Produces: `findOwnerCap(client, owner, payrollId, expectedCapId): Promise<string | null>` — returns the cap object id if the connected `owner` holds a `PayrollOwnerCap` whose `payroll_id == payrollId` AND whose object id `== expectedCapId`; else `null`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { matchOwnerCap } from "./owner-cap.js";

describe("matchOwnerCap", () => {
  const expected = "0xabc"; const payrollId = "0xpay";
  it("accepts a cap matching both payroll_id and object id", () => {
    const cap = { data: { objectId: "0xabc", content: { fields: { payroll_id: "0xpay" } } } };
    expect(matchOwnerCap(cap as any, payrollId, expected)).toBe(true);
  });
  it("rejects a cap for a different payroll (would abort on-chain)", () => {
    const cap = { data: { objectId: "0xabc", content: { fields: { payroll_id: "0xother" } } } };
    expect(matchOwnerCap(cap as any, payrollId, expected)).toBe(false);
  });
  it("rejects a cap whose object id != Payroll.owner_cap_id", () => {
    const cap = { data: { objectId: "0xdead", content: { fields: { payroll_id: "0xpay" } } } };
    expect(matchOwnerCap(cap as any, payrollId, expected)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd web && pnpm test owner-cap`
Expected: FAIL — `matchOwnerCap is not a function`.

- [ ] **Step 3: Implement `owner-cap.ts`**

```ts
import type { SuiClient } from "@mysten/sui/client";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export function matchOwnerCap(cap: any, payrollId: string, expectedCapId: string): boolean {
  const id = normalizeSuiAddress(cap.data.objectId);
  const capPayroll = normalizeSuiAddress(cap.data.content.fields.payroll_id);
  return id === normalizeSuiAddress(expectedCapId) && capPayroll === normalizeSuiAddress(payrollId);
}

export async function findOwnerCap(
  client: SuiClient, owner: string, payrollId: string, expectedCapId: string,
): Promise<string | null> {
  const type = (await import("../config/testnet.js")).TESTNET.packageId + "::payroll::PayrollOwnerCap";
  let cursor: string | null = null;
  do {
    const page = await client.getOwnedObjects({
      owner, cursor, filter: { StructType: type }, options: { showContent: true },
    });
    for (const o of page.data) {
      if (matchOwnerCap(o, payrollId, expectedCapId)) return normalizeSuiAddress(o.data!.objectId);
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return null;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd web && pnpm test owner-cap`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/chain/owner-cap.ts web/src/chain/owner-cap.test.ts
git commit -m "feat(web): #9 two-way PayrollOwnerCap gate (I4)"
```

---

### Task 5: DappKitPaydayClient adapter (C1: no pre-build)

**Files:**
- Create: `web/src/chain/dappkit-payday-client.ts`
- Test: `web/src/chain/dappkit-payday-client.test.ts`

**Interfaces:**
- Consumes: `PaydayClient` port from `@payroll-flow/orchestrator`; a `SuiClient`; and an injected `signAndExecuteFn(tx: Transaction) => Promise<{ digest: string }>` (supplied at call site from the dapp-kit `useSignAndExecuteTransaction` hook — keeps this class React-free + testable).
- Produces: `class DappKitPaydayClient implements PaydayClient`.

- [ ] **Step 1: Write the failing test** — asserts the tx is NOT built before `signAndExecute` (C1 guard).

```ts
import { describe, it, expect, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { DappKitPaydayClient } from "./dappkit-payday-client.js";

describe("DappKitPaydayClient", () => {
  it("signAndExecute delegates to the injected wallet fn with the raw Transaction (no pre-build)", async () => {
    const tx = new Transaction();
    const buildSpy = vi.spyOn(tx, "build");
    const signAndExecuteFn = vi.fn(async (t: Transaction) => {
      expect(t).toBe(tx);            // same Transaction object handed to the wallet
      return { digest: "0xdig" };
    });
    const client = new DappKitPaydayClient({} as any, signAndExecuteFn);
    const res = await client.signAndExecute(tx, { toSuiAddress: () => "0xme" });
    expect(res.kind).toBe("success");
    expect(res.digest).toBe("0xdig");
    expect(buildSpy).not.toHaveBeenCalled(); // adapter never builds; wallet does — preserves per-chunk resolve
  });

  it("getCurrentPeriod reads current_period as bigint", async () => {
    const suiClient = { getObject: vi.fn(async () => ({
      data: { content: { fields: { current_period: "7" } } } })) };
    const client = new DappKitPaydayClient(suiClient as any, vi.fn());
    expect(await client.getCurrentPeriod("0xpay")).toBe(7n);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd web && pnpm test dappkit-payday-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dappkit-payday-client.ts`**

```ts
import type { SuiClient } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import type {
  PaydayClient, PaydaySigner, DryRunResult, ExecResult,
} from "@payroll-flow/orchestrator";

export type SignAndExecuteFn = (tx: Transaction) => Promise<{ digest: string }>;

/** Implements the orchestrator PaydayClient over a browser wallet. Builds nothing itself: the wallet
 *  resolves+signs each Transaction at call time, so executePayday's per-chunk loop keeps owned-input
 *  versions fresh (C1). One instance per Run Payroll invocation. */
export class DappKitPaydayClient implements PaydayClient {
  constructor(private readonly sui: SuiClient, private readonly signAndExecuteFn: SignAndExecuteFn) {}

  async getCurrentPeriod(payrollId: string): Promise<bigint> {
    const o = await this.sui.getObject({ id: payrollId, options: { showContent: true } });
    return BigInt((o.data!.content as any).fields.current_period);
  }

  async dryRunTransaction(tx: Transaction): Promise<DryRunResult> {
    const bytes = await tx.build({ client: this.sui });
    const res = await this.sui.dryRunTransactionBlock({ transactionBlock: bytes });
    const ok = res.effects.status.status === "success";
    return { ok, error: ok ? null : res.effects.status.error ?? "dry-run failed" };
  }

  async signAndExecute(tx: Transaction, _signer: PaydaySigner): Promise<ExecResult> {
    try {
      const { digest } = await this.signAndExecuteFn(tx); // wallet builds+signs+executes
      return { kind: "success", digest, error: null, gasUsed: null };
    } catch (e) {
      return { kind: "FailedTransaction", digest: "", error: String(e), gasUsed: null };
    }
  }

  async waitForConfirm(digest: string): Promise<void> {
    await this.sui.waitForTransaction({ digest, timeout: 60_000 });
  }
}
```

> Note: dapp-kit's `useSignAndExecuteTransaction().mutateAsync({ transaction })` already does build→sign→execute and resolves the digest. `dryRunTransaction` here builds for simulation only (not the execution path) — that's fine; the executor's per-chunk preflight runs before each chunk's wallet popup, and the actual money tx is never pre-built.

- [ ] **Step 4: Run, verify pass**

Run: `cd web && pnpm test dappkit-payday-client`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/chain/dappkit-payday-client.ts web/src/chain/dappkit-payday-client.test.ts
git commit -m "feat(web): #9 DappKitPaydayClient — wallet-signed PaydayClient, no pre-build (C1)"
```

---

### Task 6: Run-payroll orchestration (FX map + mandatory period gate)

**Files:**
- Create: `web/src/payday/run-payday.ts`
- Test: `web/src/payday/run-payday.test.ts`

**Interfaces:**
- Consumes: `getFxScalars`, `buildPayday`, `executePayday`, `PaydayClient`, `EmployeeRow`, `TESTNET`.
- Produces:
  ```ts
  export function jurisdictionToPair(j: Uint8Array): FxPair;   // maps on-chain jurisdiction → FxPair
  export async function runPayday(args: {
    rows: EmployeeRow[]; reader: PayrollReader; client: PaydayClient;
    signer: PaydaySigner; resumeFrom?: number; fetchFx?: typeof getFxScalars;
  }): Promise<PaydayResult>;
  ```

- [ ] **Step 1: Write the failing test** — mandatory `expectedPeriod` wiring (C2).

```ts
import { describe, it, expect, vi } from "vitest";
import { jurisdictionToPair, runPayday } from "./run-payday.js";

describe("jurisdictionToPair", () => {
  it("maps EU jurisdiction bytes to EUR/USD", () => {
    expect(jurisdictionToPair(new TextEncoder().encode("EU"))).toBe("EUR/USD");
  });
  it("throws on unknown jurisdiction (fail loud, no silent default)", () => {
    expect(() => jurisdictionToPair(new TextEncoder().encode("ZZ"))).toThrow();
  });
});

describe("runPayday", () => {
  it("passes expectedPeriod = currentPeriod+1 on a fresh run (C2 gate)", async () => {
    const client = {
      getCurrentPeriod: vi.fn(async () => 3n),
      dryRunTransaction: vi.fn(async () => ({ ok: true, error: null })),
      signAndExecute: vi.fn(async () => ({ kind: "success", digest: "0x1", error: null, gasUsed: null })),
      waitForConfirm: vi.fn(async () => {}),
    };
    const rows = [{ addr: "0xaa", jurisdiction: new TextEncoder().encode("EU"),
      gross: 100n, withholdingBps: 0, liquidBps: 10000, scallopBps: 0, naviBps: 0,
      pendingFromPeriod: null, lastPaidPeriod: 0n, active: true }];
    const fetchFx = vi.fn(async () => ({
      fx_pair: new TextEncoder().encode("EUR/USD"), fx_rate: 1_080_000_000n,
      fx_pyth_publish_time_ms: 1_700_000_000_000n }));
    const res = await runPayday({ rows, reader: {} as any, client: client as any,
      signer: { toSuiAddress: () => "0xme" }, fetchFx: fetchFx as any });
    expect(res.completed).toBe(true);
    // executePayday read period=3 and gated against expectedPeriod=4 — no throw means gate passed
    expect(client.getCurrentPeriod).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd web && pnpm test run-payday`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `run-payday.ts`**

```ts
import {
  buildPayday, executePayday, getFxScalars,
  type FxPair, type FxScalars, type PaydayClient, type PaydaySigner,
  type PaydayResult, type PaydayConfig, type PaydayEmployee,
} from "@payroll-flow/orchestrator";
import type { EmployeeRow, PayrollReader } from "../chain/payroll-reader.js";
import { TESTNET } from "../config/testnet.js";

const JURISDICTION_PAIR: Record<string, FxPair> = {
  EU: "EUR/USD", GB: "GBP/USD", JP: "JPY/USD", EG: "EUR/GBP",
};

export function jurisdictionToPair(j: Uint8Array): FxPair {
  const key = new TextDecoder().decode(j);
  const pair = JURISDICTION_PAIR[key];
  if (!pair) throw new Error(`no FX pair mapped for jurisdiction "${key}"`);
  return pair;
}

const CONFIG: PaydayConfig = {
  packageId: TESTNET.packageId, coinType: TESTNET.coinType, payrollId: TESTNET.payrollId,
  ownerCapId: TESTNET.ownerCapId, escrowId: TESTNET.escrowId, scallopId: TESTNET.scallopId,
  naviId: TESTNET.naviId, clockId: TESTNET.clockId,
};

export async function runPayday(args: {
  rows: EmployeeRow[]; reader: PayrollReader; client: PaydayClient; signer: PaydaySigner;
  resumeFrom?: number; fetchFx?: typeof getFxScalars;
}): Promise<PaydayResult> {
  const fetchFx = args.fetchFx ?? getFxScalars;
  const active = args.rows.filter((r) => r.active);
  const employees: PaydayEmployee[] = active.map((r) => ({ addr: r.addr, pair: jurisdictionToPair(r.jurisdiction) }));

  const pairs = [...new Set(employees.map((e) => e.pair))];
  const fxByPair = new Map<string, FxScalars>();
  for (const p of pairs) fxByPair.set(p, await fetchFx(p));   // fail loud if Hermes down

  const plan = buildPayday(employees, fxByPair, CONFIG);

  const resumeFrom = args.resumeFrom ?? 0;
  const currentPeriod = await args.client.getCurrentPeriod(TESTNET.payrollId);
  const expectedPeriod = resumeFrom === 0 ? currentPeriod + 1n : currentPeriod; // C2: mandatory gate

  return executePayday(plan, TESTNET.payrollId, args.signer, args.client, { resumeFrom, expectedPeriod });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd web && pnpm test run-payday`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/payday
git commit -m "feat(web): #9 runPayday — jurisdiction→FX map + mandatory period gate (C2)"
```

---

### Task 7: create_payroll discovery + write-tx builders

**Files:**
- Create: `web/src/chain/write-txs.ts`
- Test: `web/src/chain/write-txs.test.ts`

**Interfaces:**
- Produces pure PTB builders (return `Transaction`, unbuilt):
  ```ts
  buildCreatePayroll(coinType: string): Transaction;
  buildAddEmployee(p): Transaction;   // p = {payrollId, ownerCapId, coinType, employee, jurisdiction, gross, withholdingBps}
  buildSetGross(p): Transaction;      // {payrollId, ownerCapId, coinType, employee, gross}
  buildSetRatios(p): Transaction;     // {payrollId, allocationCapId, coinType, employee, liquidBps, scallopBps, naviBps}
  buildFund(p): Transaction;          // {payrollId, ownerCapId, coinType, coinId}
  pickCreatedObjects(effects): { payrollId: string; ownerCapId: string; escrowId: string }; // by objectType
  ```

- [ ] **Step 1: Write the failing test for `pickCreatedObjects`** (I3: disambiguate by type, not order)

```ts
import { describe, it, expect } from "vitest";
import { pickCreatedObjects } from "./write-txs.js";

describe("pickCreatedObjects", () => {
  it("identifies the 3 created objects by objectType, ignoring array order", () => {
    const changes = [
      { type: "created", objectType: `0xpkg::payroll::PayrollOwnerCap`, objectId: "0xcap" },
      { type: "created", objectType: `0xpkg::escrow::TaxEscrow<0x2::sui::SUI>`, objectId: "0xesc" },
      { type: "created", objectType: `0xpkg::payroll::Payroll<0x2::sui::SUI>`, objectId: "0xpay" },
    ];
    expect(pickCreatedObjects(changes as any)).toEqual({
      payrollId: "0xpay", ownerCapId: "0xcap", escrowId: "0xesc",
    });
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd web && pnpm test write-txs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `write-txs.ts`**

```ts
import { Transaction } from "@mysten/sui/transactions";
import { TESTNET } from "../config/testnet.js";

const PKG = TESTNET.packageId;

export function buildCreatePayroll(coinType: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::payroll::create_payroll`, typeArguments: [coinType], arguments: [] });
  return tx;
}

export function buildAddEmployee(p: {
  payrollId: string; ownerCapId: string; coinType: string; employee: string;
  jurisdiction: Uint8Array; gross: bigint; withholdingBps: number;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::payroll::add_employee`, typeArguments: [p.coinType],
    arguments: [
      tx.object(p.payrollId), tx.object(p.ownerCapId), tx.pure.address(p.employee),
      tx.pure.vector("u8", Array.from(p.jurisdiction)), tx.pure.u64(p.gross), tx.pure.u16(p.withholdingBps),
    ],
  });
  return tx;
}

export function buildSetGross(p: {
  payrollId: string; ownerCapId: string; coinType: string; employee: string; gross: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::payroll::set_gross`, typeArguments: [p.coinType],
    arguments: [tx.object(p.payrollId), tx.object(p.ownerCapId), tx.pure.address(p.employee), tx.pure.u64(p.gross)],
  });
  return tx;
}

export function buildSetRatios(p: {
  payrollId: string; allocationCapId: string; coinType: string; employee: string;
  liquidBps: number; scallopBps: number; naviBps: number;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::payroll::set_ratios`, typeArguments: [p.coinType],
    arguments: [
      tx.object(p.payrollId), tx.object(p.allocationCapId), tx.pure.address(p.employee),
      tx.pure.u16(p.liquidBps), tx.pure.u16(p.scallopBps), tx.pure.u16(p.naviBps),
    ],
  });
  return tx;
}

export function buildFund(p: {
  payrollId: string; ownerCapId: string; coinType: string; coinId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::payroll::fund`, typeArguments: [p.coinType],
    arguments: [tx.object(p.payrollId), tx.object(p.ownerCapId), tx.object(p.coinId)],
  });
  return tx;
}

export function pickCreatedObjects(changes: Array<{ type: string; objectType: string; objectId: string }>) {
  const created = changes.filter((c) => c.type === "created");
  const find = (frag: string) => created.find((c) => c.objectType.includes(frag))!.objectId;
  return {
    payrollId: find("::payroll::Payroll<"),
    ownerCapId: find("::payroll::PayrollOwnerCap"),
    escrowId: find("::escrow::TaxEscrow<"),
  };
}
```

> Verify `add_employee` / `set_ratios` argument order + types against `move/sources/payroll.move` lines 138, 183 before running on-chain — the Move signature is the source of truth. Adjust `tx.pure.*` calls if the on-chain order differs.

- [ ] **Step 4: Run, verify pass**

Run: `cd web && pnpm test write-txs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/chain/write-txs.ts web/src/chain/write-txs.test.ts
git commit -m "feat(web): #9 write-tx builders + create_payroll discovery by objectType (I3)"
```

---

### Task 8: Design tokens + base panel primitives ("Headgate" theme)

**Files:**
- Create: `web/src/ui/theme.css`
- Create: `web/src/ui/Panel.tsx`, `web/src/ui/Mono.tsx`, `web/src/ui/AllocationMeter.tsx`
- Test: `web/src/ui/AllocationMeter.test.tsx`

**Interfaces:**
- Produces: CSS custom properties (colors/type per Global Constraints); `<Panel label>` (bezel frame, corner ticks); `<Mono>` (tabular monospace span); `<AllocationMeter liquidBps scallopBps naviBps taxBps>` (4-segment bar using the global colors).

- [ ] **Step 1: Create `theme.css`** (verbatim tokens from spec)

```css
:root {
  --ink:#0B1418; --panel:#11212A; --panel-edge:#1E3A44; --channel:#0E2A33;
  --mist:#9FB6BE; --chalk:#EAF2F2; --flow:#2FD4C4; --gate-red:#FF5247;
  --tax:#E2B13C; --liquid:#5BC8F5; --scallop:#7AE08B; --navi:#F2784B;
  --mono:"Berkeley Mono","Departure Mono",ui-monospace,monospace;
  --grotesk:"Schibsted Grotesk","Hanken Grotesk",system-ui,sans-serif;
}
html,body{background:var(--ink);color:var(--chalk);font-family:var(--grotesk);margin:0}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.label{text-transform:uppercase;letter-spacing:.08em;font-size:12px;color:var(--mist)}
```

- [ ] **Step 2: Write the failing AllocationMeter test**

```tsx
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AllocationMeter } from "./AllocationMeter.js";

describe("AllocationMeter", () => {
  it("renders 4 segments with widths proportional to bps", () => {
    const { container } = render(
      <AllocationMeter taxBps={0} liquidBps={5000} scallopBps={3000} naviBps={2000} />,
    );
    const segs = container.querySelectorAll("[data-seg]");
    expect(segs.length).toBe(4);
    expect((segs[1] as HTMLElement).style.width).toBe("50%"); // liquid 5000bps
  });
});
```

(Add `@testing-library/react` + `jsdom` to devDeps; set `vitest.config.ts` `environment: "jsdom"`.)

- [ ] **Step 3: Run, verify fail**

Run: `cd web && pnpm test AllocationMeter`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `Mono.tsx`, `Panel.tsx`, `AllocationMeter.tsx`**

```tsx
// Mono.tsx
export const Mono = ({ children }: { children: React.ReactNode }) =>
  <span className="num">{children}</span>;
```

```tsx
// Panel.tsx — bezel frame with corner ticks, 1px machined edge, radius<=4px
export function Panel({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid var(--panel-edge)", background: "var(--panel)",
      borderRadius: 4, padding: 16, position: "relative" }}>
      {label && <div className="label" style={{ marginBottom: 8 }}>{label}</div>}
      {children}
    </section>
  );
}
```

```tsx
// AllocationMeter.tsx — the sacred global 4-color system
const COLORS = { tax: "var(--tax)", liquid: "var(--liquid)", scallop: "var(--scallop)", navi: "var(--navi)" };
export function AllocationMeter(
  { taxBps, liquidBps, scallopBps, naviBps }: { taxBps: number; liquidBps: number; scallopBps: number; naviBps: number },
) {
  const segs: Array<[keyof typeof COLORS, number]> = [
    ["tax", taxBps], ["liquid", liquidBps], ["scallop", scallopBps], ["navi", naviBps]];
  return (
    <div style={{ display: "flex", height: 6, width: "100%", borderRadius: 2, overflow: "hidden" }}>
      {segs.map(([k, bps]) => (
        <div key={k} data-seg={k} style={{ width: `${bps / 100}%`, background: COLORS[k] }} />
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run, verify pass**

Run: `cd web && pnpm test AllocationMeter`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/ui web/vitest.config.ts web/package.json
git commit -m "feat(web): #9 Headgate theme tokens + Panel/Mono/AllocationMeter primitives"
```

---

### Task 9: Roster manifest strip

**Files:**
- Create: `web/src/components/Roster.tsx`
- Create: `web/src/hooks/usePayrollState.ts`

**Interfaces:**
- Consumes: `ChainPayrollReader`, `EmployeeRow`, `AllocationMeter`, `useSuiClient` (dapp-kit).
- Produces: `usePayrollState()` → react-query hook returning `{ rows, currentPeriod, ownerCapId, isLoading, refetch }`; `<Roster onSelect>` rendering the ledger strip.

- [ ] **Step 1: Implement `usePayrollState.ts`**

```ts
import { useSuiClient } from "@mysten/dapp-kit-react";
import { useQuery } from "@tanstack/react-query";
import { ChainPayrollReader } from "../chain/payroll-reader.js";
import { TESTNET } from "../config/testnet.js";

export function usePayrollState() {
  const client = useSuiClient();
  const reader = new ChainPayrollReader(client);
  return useQuery({
    queryKey: ["payroll", TESTNET.payrollId],
    queryFn: async () => ({
      rows: await reader.listEmployees(TESTNET.payrollId),
      currentPeriod: await reader.currentPeriod(TESTNET.payrollId),
      ownerCapId: await reader.ownerCapId(TESTNET.payrollId),
    }),
  });
}
```

- [ ] **Step 2: Implement `Roster.tsx`** (full-bleed hairline rows, inline meter, mono money, status dot)

```tsx
import type { EmployeeRow } from "../chain/payroll-reader.js";
import { AllocationMeter } from "../ui/AllocationMeter.js";

const dot = (r: EmployeeRow) => r.active ? "var(--flow)" : "var(--mist)";

export function Roster({ rows, onSelect }: { rows: EmployeeRow[]; onSelect: (r: EmployeeRow) => void }) {
  if (rows.length === 0)
    return <div className="label" style={{ padding: 24 }}>NO HEAD PRESSURE — FUND TO ARM</div>;
  return (
    <div>
      {rows.map((r) => (
        <button key={r.addr} onClick={() => onSelect(r)}
          style={{ display: "grid", gridTemplateColumns: "16px 1fr 120px 160px", gap: 12,
            alignItems: "center", width: "100%", height: 44, background: "none",
            borderBottom: "1px solid var(--panel-edge)", color: "var(--chalk)", textAlign: "left" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%",
            background: r.lastPaidPeriod === 0n ? "transparent" : dot(r),
            border: `1px solid ${dot(r)}` }} />
          <span className="num">{r.addr.slice(0, 10)}…{r.addr.slice(-4)}</span>
          <span className="num" style={{ textAlign: "right" }}>{r.gross.toString()}</span>
          <AllocationMeter taxBps={r.withholdingBps} liquidBps={r.liquidBps}
            scallopBps={r.scallopBps} naviBps={r.naviBps} />
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Visual verify** — wire `<Roster rows={usePayrollState().data.rows}>` temporarily into `App.tsx`, run `pnpm dev`, connect wallet on testnet.
Expected: 3 testnet employees render as hairline rows with mono gross + 4-color meter; no zebra, no card grid.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Roster.tsx web/src/hooks/usePayrollState.ts
git commit -m "feat(web): #9 roster manifest strip + on-chain payroll state hook"
```

---

### Task 10: Gate-config inspector drawer (CRUD)

**Files:**
- Create: `web/src/components/GateConfigDrawer.tsx`
- Create: `web/src/components/RatioSliders.tsx`
- Test: `web/src/components/RatioSliders.test.tsx`

**Interfaces:**
- Consumes: write-tx builders, `useSignAndExecuteTransaction` (dapp-kit), `AllocationMeter`.
- Produces: `<GateConfigDrawer employee onClose onDone>` with add/edit forms; `<RatioSliders value onChange>` enforcing sum == 10000.

- [ ] **Step 1: Write failing RatioSliders sum test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ratioError } from "./RatioSliders.js";

describe("ratioError", () => {
  it("rejects bps not summing to 10000", () => {
    expect(ratioError({ liquidBps: 5000, scallopBps: 3000, naviBps: 1000 })).toMatch(/10000/);
  });
  it("accepts an exact 10000 split", () => {
    expect(ratioError({ liquidBps: 5000, scallopBps: 3000, naviBps: 2000 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd web && pnpm test RatioSliders`
Expected: FAIL — `ratioError is not a function`.

- [ ] **Step 3: Implement `RatioSliders.tsx`** (validation + linked sliders feeding the meter)

```tsx
import { AllocationMeter } from "../ui/AllocationMeter.js";
export interface Ratios { liquidBps: number; scallopBps: number; naviBps: number; }

export function ratioError(r: Ratios): string | null {
  return r.liquidBps + r.scallopBps + r.naviBps === 10000 ? null : "ratios must sum to 10000 bps";
}

export function RatioSliders({ value, onChange }: { value: Ratios; onChange: (r: Ratios) => void }) {
  const err = ratioError(value);
  const slider = (k: keyof Ratios, color: string) => (
    <label style={{ display: "block" }}>
      <span className="label" style={{ color }}>{k}</span>
      <input type="range" min={0} max={10000} step={100} value={value[k]}
        onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) })} />
      <span className="num">{value[k]}</span>
    </label>
  );
  return (
    <div>
      {slider("liquidBps", "var(--liquid)")}
      {slider("scallopBps", "var(--scallop)")}
      {slider("naviBps", "var(--navi)")}
      <AllocationMeter taxBps={0} liquidBps={value.liquidBps} scallopBps={value.scallopBps} naviBps={value.naviBps} />
      <div className="num" style={{ color: err ? "var(--gate-red)" : "var(--mist)" }}>
        {err ?? "balanced"}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd web && pnpm test RatioSliders`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `GateConfigDrawer.tsx`** (right-side drawer; add_employee/set_gross/set_ratios via wallet)

```tsx
import { useSignAndExecuteTransaction } from "@mysten/dapp-kit-react";
import { useState } from "react";
import type { EmployeeRow } from "../chain/payroll-reader.js";
import { buildAddEmployee, buildSetGross, buildSetRatios } from "../chain/write-txs.js";
import { RatioSliders, type Ratios } from "./RatioSliders.js";
import { TESTNET } from "../config/testnet.js";

export function GateConfigDrawer(
  { employee, ownerCapId, allocationCapId, onClose, onDone }:
  { employee: EmployeeRow | "new"; ownerCapId: string; allocationCapId?: string;
    onClose: () => void; onDone: () => void },
) {
  const { mutateAsync } = useSignAndExecuteTransaction();
  const [ratios, setRatios] = useState<Ratios>({ liquidBps: 10000, scallopBps: 0, naviBps: 0 });

  async function saveRatios() {
    if (employee === "new" || !allocationCapId) return;
    await mutateAsync({ transaction: buildSetRatios({
      payrollId: TESTNET.payrollId, allocationCapId, coinType: TESTNET.coinType,
      employee: employee.addr, ...ratios }) });
    onDone();
  }
  // add_employee / set_gross forms follow the same mutateAsync(buildX(...)) shape.

  return (
    <aside style={{ position: "fixed", right: 0, top: 0, height: "100%", width: 360,
      borderLeft: "1px solid var(--panel-edge)", background: "var(--panel)", padding: 16 }}>
      <div className="label">GATE CONFIG</div>
      <RatioSliders value={ratios} onChange={setRatios} />
      <button onClick={saveRatios}>STAGE RATIOS</button>
      <button onClick={onClose}>CLOSE</button>
    </aside>
  );
}
```

> Fill the add_employee + set_gross forms with `buildAddEmployee`/`buildSetGross` — same `mutateAsync({ transaction })` pattern; jurisdiction entered as a 2-letter code → `new TextEncoder().encode(code)`.

- [ ] **Step 6: Visual + on-chain verify** — open drawer on a testnet employee, stage ratios, confirm wallet tx lands; re-fetch roster shows pending.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/GateConfigDrawer.tsx web/src/components/RatioSliders.tsx web/src/components/RatioSliders.test.tsx
git commit -m "feat(web): #9 gate-config drawer CRUD + ratio sliders (sum-to-10000)"
```

---

### Task 11: Fund panel (head pressure)

**Files:**
- Create: `web/src/components/FundPanel.tsx`

**Interfaces:**
- Consumes: `buildFund`, `useSuiClient`, `useCurrentAccount`, `useSignAndExecuteTransaction`, funded balance from `usePayrollState`.
- Produces: `<FundPanel funded onDone>` — pick a coin (NOT the gas coin, N2), fund, render funded balance as a head-pressure fill bar.

- [ ] **Step 1: Implement `FundPanel.tsx`**

```tsx
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit-react";
import { useState } from "react";
import { buildFund } from "../chain/write-txs.js";
import { TESTNET } from "../config/testnet.js";

export function FundPanel({ funded, onDone }: { funded: bigint; onDone: () => void }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync } = useSignAndExecuteTransaction();
  const [amount] = useState(0n);

  async function fund() {
    if (!account) return;
    // pick a coin object that is NOT the wallet's gas coin (N2)
    const coins = await client.getCoins({ owner: account.address, coinType: TESTNET.coinType });
    const fundCoin = coins.data.find((c) => BigInt(c.balance) > amount);
    if (!fundCoin) throw new Error("no coin with sufficient balance to fund");
    await mutateAsync({ transaction: buildFund({
      payrollId: TESTNET.payrollId, ownerCapId: TESTNET.ownerCapId,
      coinType: TESTNET.coinType, coinId: fundCoin.coinObjectId }) });
    onDone();
  }

  const pct = Number(funded > 0n ? 100n : 0n); // head-pressure indicator
  return (
    <div style={{ background: "var(--channel)", borderRadius: 4, padding: 12 }}>
      <div className="label">HEAD PRESSURE</div>
      <div style={{ height: 8, background: "var(--ink)", borderRadius: 2 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--flow)" }} />
      </div>
      <span className="num">{funded.toString()}</span>
      <button onClick={fund}>FUND</button>
    </div>
  );
}
```

- [ ] **Step 2: On-chain verify** — fund the testnet payroll, head-pressure bar reflects new balance after refetch.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/FundPanel.tsx
git commit -m "feat(web): #9 fund panel — head-pressure, non-gas coin selection (N2)"
```

---

### Task 12: Headgate console — Run Payroll lever + flow + state machine

**Files:**
- Create: `web/src/components/HeadgateConsole.tsx`
- Create: `web/src/components/FlowViz.tsx`

**Interfaces:**
- Consumes: `runPayday`, `DappKitPaydayClient`, `useSignAndExecuteTransaction`, `useSuiClient`, `usePayrollState`, `PaydayResult`, `PeriodGateError`.
- Produces: `<HeadgateConsole rows ownerCapId onDone>` — lever state machine (Armed→Pull→Flow→Sealed), per-chunk wallet popups, receipts/gas/period readout, PeriodGate seal.

- [ ] **Step 1: Implement `HeadgateConsole.tsx`** (orchestration; flow animation in FlowViz)

```tsx
import { useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit-react";
import { useState } from "react";
import { DappKitPaydayClient } from "../chain/dappkit-payday-client.js";
import { runPayday } from "../payday/run-payday.js";
import { PeriodGateError, type PaydayResult } from "@payroll-flow/orchestrator";
import type { EmployeeRow } from "../chain/payroll-reader.js";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

type Gate = "armed" | "flowing" | "sealed" | "error";

export function HeadgateConsole(
  { rows, onDone }: { rows: EmployeeRow[]; onDone: () => void },
) {
  const sui = useSuiClient();
  const account = useCurrentAccount();
  const { mutateAsync } = useSignAndExecuteTransaction();
  const [gate, setGate] = useState<Gate>("armed");
  const [result, setResult] = useState<PaydayResult | null>(null);
  const [resumeFrom, setResumeFrom] = useState(0);
  const [msg, setMsg] = useState<string>("");

  async function pull() {
    if (!account) return;
    setGate("flowing");
    const client = new DappKitPaydayClient(sui, async (tx) => {
      const r = await mutateAsync({ transaction: tx });
      return { digest: r.digest };
    });
    try {
      const res = await runPayday({ rows, reader: {} as any, client,
        signer: { toSuiAddress: () => account.address }, resumeFrom });
      setResult(res);
      if (res.completed) { setGate("sealed"); onDone(); }
      else { setResumeFrom(res.nextResumeFrom!); setGate("armed"); setMsg("chunk rejected — RESUME only"); }
    } catch (e) {
      if (e instanceof PeriodGateError) { setGate("sealed"); setMsg("PERIOD SEALED"); }
      else { setGate("error"); setMsg(String(e)); }
    }
  }

  const sealed = gate === "sealed";
  return (
    <div style={{ borderTop: "1px solid var(--panel-edge)", padding: 16,
      background: "var(--panel)", display: "flex", gap: 16, alignItems: "center" }}>
      <button disabled={gate === "flowing" || sealed} onClick={pull}
        style={{ background: sealed ? "var(--gate-red)" : "var(--flow)", color: "var(--ink)",
          padding: "12px 24px", borderRadius: 4, fontWeight: 700 }}>
        {resumeFrom > 0 ? "RESUME PAYDAY" : "RUN PAYROLL"}
      </button>
      <span className="num">{msg}</span>
      {result && <span className="num">
        period→{result.receipts.at(-1)?.paidAtPeriod?.toString() ?? "—"} ·
        gas {result.receipts.reduce((s, r) => s + (r.gasUsed ?? 0n), 0n).toString()}
      </span>}
    </div>
  );
}
```

- [ ] **Step 2: Implement `FlowViz.tsx`** — Motion-animated channel forking into 4 stream colors; row-drain particle keyed to confirmed chunk index. (Visual; drives off `result.receipts[].status`.)

```tsx
import { motion } from "motion/react";
// Channel left→right fill, then 4 forks colored tax/liquid/scallop/navi into basins.
// Animate each basin's fill proportional to aggregate bps of confirmed chunks.
export function FlowViz({ active }: { active: boolean }) {
  const streams = ["var(--tax)", "var(--liquid)", "var(--scallop)", "var(--navi)"];
  return (
    <div style={{ display: "flex", gap: 8, height: 48 }}>
      {streams.map((c, i) => (
        <motion.div key={i} initial={{ scaleY: 0 }} animate={{ scaleY: active ? 1 : 0 }}
          transition={{ delay: i * 0.12 }} style={{ flex: 1, background: c, transformOrigin: "top" }} />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: On-chain verify (the demo)** — connect employer wallet (OwnerCap holder), Run Payroll: each chunk popups, period 0→1, receipts show net gas. Then click again → `PeriodGateError` → console shows "PERIOD SEALED", lever disabled. Cross-check against `ts/scripts/e2e-payday.ts` output.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/HeadgateConsole.tsx web/src/components/FlowViz.tsx
git commit -m "feat(web): #9 headgate console — Run Payroll lever, flow viz, period-seal"
```

---

### Task 13: Connect + payroll picker + create_payroll, assemble App

**Files:**
- Create: `web/src/components/ConnectBar.tsx`, `web/src/components/Rail.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `ConnectButton`/`useCurrentAccount` (dapp-kit), `findOwnerCap`, `buildCreatePayroll`, `pickCreatedObjects`, all components above, `usePayrollState`.
- Produces: assembled dashboard — rail (identity, OwnerCap dot, period odometer), connect, create-or-select payroll, roster, drawer, fund, console.

- [ ] **Step 1: Implement `Rail.tsx`** (left rail: payroll id, OwnerCap status dot, period odometer)

```tsx
export function Rail({ ownerCapOk, period }: { ownerCapOk: boolean; period: bigint }) {
  return (
    <nav style={{ width: 200, borderRight: "1px solid var(--panel-edge)", padding: 16 }}>
      <div className="label">SLUICE</div>
      <div className="label">OWNER CAP</div>
      <span style={{ width: 8, height: 8, borderRadius: "50%",
        background: ownerCapOk ? "var(--flow)" : "var(--gate-red)", display: "inline-block" }} />
      <div className="label" style={{ marginTop: 16 }}>PERIOD</div>
      <div className="num" style={{ fontSize: 28 }}>{period.toString().padStart(4, "0")}</div>
    </nav>
  );
}
```

- [ ] **Step 2: Implement `ConnectBar.tsx`** — dapp-kit `ConnectButton`; on connect, run `findOwnerCap` to gate writes; if no payroll, offer `create_payroll` via `mutateAsync(buildCreatePayroll(coinType))` + `pickCreatedObjects(result.objectChanges)`.

```tsx
import { ConnectButton, useSignAndExecuteTransaction } from "@mysten/dapp-kit-react";
import { buildCreatePayroll, pickCreatedObjects } from "../chain/write-txs.js";
import { TESTNET } from "../config/testnet.js";

export function ConnectBar({ onCreated }: { onCreated: (ids: ReturnType<typeof pickCreatedObjects>) => void }) {
  const { mutateAsync } = useSignAndExecuteTransaction();
  async function create() {
    const r = await mutateAsync({ transaction: buildCreatePayroll(TESTNET.coinType),
      options: { showObjectChanges: true } } as any);
    onCreated(pickCreatedObjects((r as any).objectChanges));
  }
  return (
    <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", padding: 12 }}>
      <ConnectButton />
      <button onClick={create}>NEW PAYROLL</button>
    </div>
  );
}
```

- [ ] **Step 3: Assemble `App.tsx`** — layout skeleton: Rail | (ConnectBar + head-pressure channel + Roster + Console) | GateConfigDrawer. Wire `usePayrollState`, owner-cap gate (disable write buttons when `!ownerCapOk`), refetch after each tx.

- [ ] **Step 4: Typecheck + full test run**

Run: `cd web && pnpm typecheck && pnpm test`
Expected: tsc clean; all vitest pass.

- [ ] **Step 5: Full demo dry-run (testnet)** — connect OwnerCap wallet → roster shows 3 employees → add a 4th (add_employee) → fund → Run Payroll (period 0→1, 4 employees paid) → second Run blocked (PERIOD SEALED). Compare to `ts/scripts/e2e-payday.ts`.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Rail.tsx web/src/components/ConnectBar.tsx web/src/App.tsx
git commit -m "feat(web): #9 assemble dashboard — rail, connect, create_payroll, full layout"
```

---

### Task 14: Monkey testing + polish pass

**Files:**
- Modify: components as needed for the edge cases below.
- Create: `web/MONKEY.md` (record what was tried + outcomes).

**Interfaces:** none new.

- [ ] **Step 1: Run the monkey checklist on testnet** and record results in `web/MONKEY.md`:
  - Wallet rejects chunk[0] → full retry still allowed (lever stays RUN PAYROLL).
  - Wallet rejects chunk[N>0] (needs >50 employees, or simulate) → only RESUME offered; full re-run disabled (N1).
  - Double Run Payroll → `PeriodGateError` → "PERIOD SEALED", lever disabled.
  - Empty roster → "NO HEAD PRESSURE — FUND TO ARM", Run disabled.
  - Employee with gross=0 → included but pays 0 (matches Move).
  - set_ratios summing ≠ 10000 → STAGE disabled / gate-red.
  - Connected wallet without OwnerCap → all write buttons disabled, rail dot gate-red.
  - Fund with no sufficient coin → loud error, no silent no-op.

- [ ] **Step 2: Fix any failures found**, re-run.

- [ ] **Step 3: Final typecheck + tests**

Run: `cd web && pnpm typecheck && pnpm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/MONKEY.md web/src
git commit -m "test(web): #9 monkey testing pass + edge-case hardening"
```

---

## Self-Review

**Spec coverage:**
- Foundation #0 (workspace, scaffold, providers, config) → Tasks 1–2. ✓
- PayrollReader port + on-chain reads (I1/I2) → Task 3. ✓
- Owner-cap two-way gate (I4) → Task 4. ✓
- DappKitPaydayClient no-pre-build (C1) → Task 5. ✓
- runPayday mandatory period gate (C2) → Task 6. ✓
- create_payroll discovery (I3) + write builders → Task 7. ✓
- Full CRUD (add_employee/set_gross/set_ratios/fund) → Tasks 7, 10, 11. ✓
- Run Payroll flow + receipts/gas/period + PeriodGate → Task 12. ✓
- Headgate design (theme, roster manifest, meter, lever, flow viz, anti-AI-slop) → Tasks 8–13. ✓
- Monkey testing (project rule) + N1 invariant → Task 14. ✓
- N3 (GraphQL/gRPC read path) → deferred behind `PayrollReader` port (noted, not built — JSON-RPC for now). ✓

**Placeholder scan:** UI tasks intentionally carry component skeletons + visual/on-chain verification (lever animation/flow can't be meaningfully unit-tested); all logic tasks (3–8, 10) carry real failing tests first. The two "follow the same pattern" notes (drawer forms, FlowViz detail) reference fully-shown sibling code in the same task, not absent code.

**Type consistency:** `EmployeeRow`, `PayrollReader`, `PaydayClient`, `runPayday`, `PaydayConfig`, `Ratios`, `pickCreatedObjects` signatures are consistent across tasks. `signAndExecuteFn`/`SignAndExecuteFn` naming aligned (Task 5 ↔ Task 12). bps fields (`liquidBps`/`scallopBps`/`naviBps`/`withholdingBps`) consistent everywhere.

**Known verification points flagged inline** (per lessons — verify installed SDK shapes, not docs): dapp-kit-react version + provider import paths (Task 2), captured fixture as decode source-of-truth (Task 3), Move arg order for write builders (Task 7).
