import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export interface EmployeeRow {
  addr: string;
  jurisdiction: Uint8Array;
  gross: bigint;
  withholdingBps: number;
  liquidBps: number;
  scallopBps: number;
  naviBps: number;
  pendingFromPeriod: bigint | null;
  lastPaidPeriod: bigint;
  active: boolean;
}

export interface PayrollReader {
  listEmployees(payrollId: string): Promise<EmployeeRow[]>;
  currentPeriod(payrollId: string): Promise<bigint>;
  ownerCapId(payrollId: string): Promise<string>;
  funding(payrollId: string): Promise<bigint>;
}

// obj = getDynamicFieldObject response; paths matched to captured fixture
export function decodeEmployeeField(obj: any): EmployeeRow {
  const v = obj.data.content.fields.value.fields;
  const a = v.allocation.fields;
  // pending is null or an Option<AllocationPending> object with fields
  const pending = a.pending != null ? (a.pending.fields ?? a.pending) : null;
  return {
    addr: normalizeSuiAddress(v.employee),
    jurisdiction: Uint8Array.from(v.jurisdiction as number[]),
    gross: BigInt(v.gross),
    withholdingBps: Number(v.withholding_bps),
    liquidBps: Number(a.liquid_bps),
    scallopBps: Number(a.scallop_usdc_bps),
    naviBps: Number(a.navi_btc_bps),
    pendingFromPeriod: pending != null ? BigInt(pending.effective_from_period) : null,
    lastPaidPeriod: BigInt(v.last_paid_period),
    active: Boolean(v.active),
  };
}

export class ChainPayrollReader implements PayrollReader {
  constructor(private readonly client: SuiJsonRpcClient) {}

  async listEmployees(payrollId: string): Promise<EmployeeRow[]> {
    const obj = await this.client.getObject({ id: payrollId, options: { showContent: true } });
    const tableId = (obj.data!.content as any).fields.employees.fields.id.id;
    const rows: EmployeeRow[] = [];
    let cursor: string | null | undefined = undefined;
    do {
      const page = await this.client.getDynamicFields({ parentId: tableId, cursor: cursor ?? undefined });
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

  async funding(payrollId: string): Promise<bigint> {
    const obj = await this.client.getObject({ id: payrollId, options: { showContent: true } });
    // Balance<T> serializes as a plain u64 string at content.fields.funding
    return BigInt((obj.data!.content as any).fields.funding);
  }
}
