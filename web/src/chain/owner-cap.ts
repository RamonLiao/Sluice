import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export function matchOwnerCap(cap: any, payrollId: string, expectedCapId: string): boolean {
  const id = normalizeSuiAddress(cap.data.objectId);
  const capPayroll = normalizeSuiAddress(cap.data.content.fields.payroll_id);
  return id === normalizeSuiAddress(expectedCapId) && capPayroll === normalizeSuiAddress(payrollId);
}

export async function findOwnerCap(
  client: SuiJsonRpcClient, owner: string, payrollId: string, expectedCapId: string,
): Promise<string | null> {
  const type = (await import("../config/testnet.js")).TESTNET.packageId + "::payroll::PayrollOwnerCap";
  let cursor: string | null | undefined = null;
  do {
    const page = await client.getOwnedObjects({
      owner,
      cursor: cursor ?? undefined,
      filter: { StructType: type },
      options: { showContent: true },
    });
    for (const o of page.data) {
      if (matchOwnerCap(o, payrollId, expectedCapId)) return normalizeSuiAddress(o.data!.objectId);
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return null;
}
