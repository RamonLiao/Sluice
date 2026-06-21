import { Transaction } from "@mysten/sui/transactions";
import { TESTNET } from "../config/testnet.js";

const PKG = TESTNET.packageId;

export function buildCreatePayroll(coinType: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::payroll::create_payroll`, typeArguments: [coinType], arguments: [] });
  return tx;
}

export function buildAddEmployee(p: {
  payrollId: string;
  ownerCapId: string;
  coinType: string;
  employee: string;
  jurisdiction: Uint8Array;
  gross: bigint;
  withholdingBps: number;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::payroll::add_employee`,
    typeArguments: [p.coinType],
    arguments: [
      tx.object(p.payrollId),
      tx.object(p.ownerCapId),
      tx.pure.address(p.employee),
      tx.pure.vector("u8", Array.from(p.jurisdiction)),
      tx.pure.u64(p.gross),
      tx.pure.u16(p.withholdingBps),
    ],
  });
  return tx;
}

export function buildSetGross(p: {
  payrollId: string;
  ownerCapId: string;
  coinType: string;
  employee: string;
  gross: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::payroll::set_gross`,
    typeArguments: [p.coinType],
    arguments: [
      tx.object(p.payrollId),
      tx.object(p.ownerCapId),
      tx.pure.address(p.employee),
      tx.pure.u64(p.gross),
    ],
  });
  return tx;
}

export function buildSetRatios(p: {
  payrollId: string;
  allocationCapId: string;
  coinType: string;
  employee: string;
  liquidBps: number;
  scallopBps: number;
  naviBps: number;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::payroll::set_ratios`,
    typeArguments: [p.coinType],
    arguments: [
      tx.object(p.payrollId),
      tx.object(p.allocationCapId),
      tx.pure.address(p.employee),
      tx.pure.u16(p.liquidBps),
      tx.pure.u16(p.scallopBps),
      tx.pure.u16(p.naviBps),
    ],
  });
  return tx;
}

export function buildFund(p: {
  payrollId: string;
  ownerCapId: string;
  coinType: string;
  coinId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::payroll::fund`,
    typeArguments: [p.coinType],
    arguments: [
      tx.object(p.payrollId),
      tx.object(p.ownerCapId),
      tx.object(p.coinId),
    ],
  });
  return tx;
}

export function pickCreatedObjects(
  changes: Array<{ type: string; objectType: string; objectId: string }>,
): { payrollId: string; ownerCapId: string; escrowId: string } {
  const created = changes.filter((c) => c.type === "created");
  const find = (frag: string) => created.find((c) => c.objectType.includes(frag))!.objectId;
  return {
    payrollId: find("::payroll::Payroll<"),
    ownerCapId: find("::payroll::PayrollOwnerCap"),
    escrowId: find("::escrow::TaxEscrow<"),
  };
}
