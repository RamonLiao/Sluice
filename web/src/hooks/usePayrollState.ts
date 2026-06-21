import { useCurrentClient } from "@mysten/dapp-kit-react";
import { useQuery } from "@tanstack/react-query";
import { ChainPayrollReader } from "../chain/payroll-reader.js";
import { TESTNET } from "../config/testnet.js";
import { dAppKit } from "../providers.js";

export function usePayrollState() {
  const client = useCurrentClient({ dAppKit });
  return useQuery({
    queryKey: ["payroll", TESTNET.payrollId],
    queryFn: async () => {
      const reader = new ChainPayrollReader(client);
      return {
        rows: await reader.listEmployees(TESTNET.payrollId),
        currentPeriod: await reader.currentPeriod(TESTNET.payrollId),
        ownerCapId: await reader.ownerCapId(TESTNET.payrollId),
      };
    },
  });
}
