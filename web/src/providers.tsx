/**
 * providers.tsx — dapp-kit-react@2.x API
 *
 * DEVIATION FROM BRIEF — API changed:
 * The brief assumed @mysten/dapp-kit@0.x (SuiClientProvider/WalletProvider/
 * createNetworkConfig). That package now requires @mysten/sui@^2.x on v1.x,
 * and @mysten/dapp-kit-react never had those exports.
 *
 * Chosen: @mysten/dapp-kit-react@2.1.3 + @mysten/dapp-kit-core@1.6.1
 *   - createDAppKit from "@mysten/dapp-kit-core"
 *   - DAppKitProvider from "@mysten/dapp-kit-react"
 *   - SuiJsonRpcClient from "@mysten/sui/jsonRpc" (web-only, v2.19.0)
 *
 * Hooks for tasks 9-13 — import from "@mysten/dapp-kit-react":
 *   useCurrentAccount, useCurrentWallet, useWallets, useWalletConnection,
 *   useDAppKit({ dAppKit }) — pass the exported `dAppKit` instance.
 *
 * The orchestrator (ts/) keeps @mysten/sui@1.45.2 (separate workspace pkg).
 */

import { createDAppKit } from "@mysten/dapp-kit-core";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const TESTNET_URL = "https://fullnode.testnet.sui.io:443";

export const dAppKit = createDAppKit({
  networks: ["testnet"] as const,
  defaultNetwork: "testnet",
  createClient: (_network) =>
    new SuiJsonRpcClient({ network: "testnet", url: TESTNET_URL }),
  autoConnect: true,
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>
    </QueryClientProvider>
  );
}
