// One-shot testnet setup. Run AFTER `sui client publish` and writing packageId into ts/testnet.json.
// Usage: cd ts && SUI_PRIVATE_KEY=suiprivkey... npx tsx scripts/testnet-setup.ts
//
// Creates the shared objects a payday needs (Payroll/TaxEscrow/mock vaults), funds the pool,
// adds 3 employees, and writes the full ts/testnet.json. Exercises the same gRPC execute path
// the adapter uses, so a green run is also an early integration smoke test.
import { readFileSync, writeFileSync } from "node:fs";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const SUI = "0x2::sui::SUI";
const CFG = "./testnet.json";

const cfg = JSON.parse(readFileSync(CFG, "utf8"));
if (!cfg.packageId) throw new Error("set packageId in testnet.json (from sui client publish) first");

const kp = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
const me = kp.toSuiAddress();
// TRANSITIONAL: JSON-RPC for build + execute (gRPC unusable in 1.45.2 vs testnet — see grpc-client.ts).
const rpc = new SuiClient({ url: getFullnodeUrl("testnet") });
const core = rpc.core;
const pkg = cfg.packageId as string;

interface Created { id: string; type: string }

/** build → sign → execute → wait → return created objects (id + type via getObjects). */
async function run(tx: Transaction, label: string): Promise<Created[]> {
  tx.setSender(me);
  const bytes = await tx.build({ client: rpc });
  const { signature } = await kp.signTransaction(bytes);
  const { transaction } = await core.executeTransaction({ transaction: bytes, signatures: [signature] });
  if (!transaction.effects.status.success) throw new Error(`${label} failed: ${transaction.effects.status.error}`);
  await core.waitForTransaction({ digest: transaction.digest });

  const ids = transaction.effects.changedObjects
    .filter((c) => c.idOperation === "Created")
    .map((c) => c.id);
  if (ids.length === 0) return [];
  const { objects } = await core.getObjects({ objectIds: ids });
  return objects.flatMap((o, i) =>
    o instanceof Error ? [] : [{ id: ids[i]!, type: (o as { type: string }).type }],
  );
}

const pick = (objs: Created[], suffix: string): string => {
  const hit = objs.find((o) => o.type.startsWith(`${pkg}::${suffix}`));
  if (!hit) throw new Error(`no created object of type ${pkg}::${suffix} — got ${JSON.stringify(objs.map((o) => o.type))}`);
  return hit.id;
};

// 1. create_payroll<SUI> → Payroll<SUI> (shared), TaxEscrow<SUI> (shared), PayrollOwnerCap (owned)
{
  const tx = new Transaction();
  tx.moveCall({ target: `${pkg}::payroll::create_payroll`, typeArguments: [SUI], arguments: [] });
  const objs = await run(tx, "create_payroll");
  cfg.payrollId = pick(objs, "payroll::Payroll");
  cfg.escrowId = pick(objs, "escrow::TaxEscrow");
  cfg.ownerCapId = pick(objs, "payroll::PayrollOwnerCap");
}

// 2. mock_scallop::create<SUI>(rate_per_sec, clock) → MockScallopVault<SUI> (shared) + AdminCap
{
  const tx = new Transaction();
  // create returns the AdminCap (key+store, no drop) — must be consumed or the PTB aborts.
  const cap = tx.moveCall({ target: `${pkg}::mock_scallop::create`, typeArguments: [SUI], arguments: [tx.pure.u128(0n), tx.object("0x6")] });
  tx.transferObjects([cap], me);
  const objs = await run(tx, "mock_scallop::create");
  cfg.scallopId = pick(objs, "mock_scallop::MockScallopVault");
  cfg.scallopAdminCapId = pick(objs, "mock_scallop::AdminCap");
}

// 3. mock_navi::create<SUI>(index_price) → MockNaviVault<SUI> (shared) + AdminCap
{
  const tx = new Transaction();
  const cap = tx.moveCall({ target: `${pkg}::mock_navi::create`, typeArguments: [SUI], arguments: [tx.pure.u64(1n)] });
  tx.transferObjects([cap], me);
  const objs = await run(tx, "mock_navi::create");
  cfg.naviId = pick(objs, "mock_navi::MockNaviVault");
  cfg.naviAdminCapId = pick(objs, "mock_navi::AdminCap");
}

// 4. fund<SUI>: split a distinct funding coin from gas (S7 anti-equivocation). The split-off coin
//    is a NEW object used only as the Move-call input — never the gas coin.
{
  const tx = new Transaction();
  const [funding] = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000n)]); // 0.1 SUI into the pool
  tx.moveCall({ target: `${pkg}::payroll::fund`, typeArguments: [SUI], arguments: [tx.object(cfg.payrollId), tx.object(cfg.ownerCapId), funding] });
  await run(tx, "fund");
}

// 5. add_employee<SUI> × 3 (distinct fresh addresses). gross 1_000_000 MIST, 10% withholding.
const employees = [Ed25519Keypair.generate(), Ed25519Keypair.generate(), Ed25519Keypair.generate()].map((k) => k.toSuiAddress());
for (const emp of employees) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::payroll::add_employee`, typeArguments: [SUI],
    arguments: [tx.object(cfg.payrollId), tx.object(cfg.ownerCapId), tx.pure.address(emp), tx.pure.vector("u8", [...new TextEncoder().encode("US")]), tx.pure.u64(1_000_000n), tx.pure.u16(1000)],
  });
  await run(tx, `add_employee ${emp.slice(0, 10)}`);
}
cfg.employees = employees;
cfg.coinType = SUI;
cfg.network = "testnet";

writeFileSync(CFG, JSON.stringify(cfg, null, 2));
console.log("testnet.json written:\n", JSON.stringify(cfg, null, 2));
