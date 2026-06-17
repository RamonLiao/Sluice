# TODO #7 — Pyth FX 鏈下整合（Opt 2）Design

_Date: 2026-06-17 · Status: approved-for-planning_

## 0. 決策

| ID | 決策 | 理由 |
|----|------|------|
| #7-A | **鏈下解析（Opt 2）**，非鏈上 adapter | FX 是 D9 reporting-only，**不在 USDC value path**。鏈上 Pyth 的信任最小化買不到東西，卻要付 mainnet liveness 依賴 + 每 payday VAA update 成本。信任缺口有界（operator 只能污染自己審計記錄，無法 misroute 資金）。 |
| #7-B | **fx_rate = D9 定點**（`round(price × 1e9)`，u64） | 與 notes「fx D9 reporting」一致；Sui 生態常見。一旦上 mainnet 改縮放 = D11 upgrade，故此處釘死。 |
| #7-C | seam 簽名**不變** | `pay_one(fx_pair, fx_rate, fx_pyth_publish_time, clock)` 已存在；#7 零 Move source 改動。未來升 Opt 1 為 non-breaking。 |
| #7-D | MVP pairs = **EUR/USD, GBP/USD, JPY/USD, EUR/GBP** | 由 FEEDS config map 驅動，加幣別只改 config。 |
| #7-E | 套件管理 **pnpm** | — |
| #7-F | 顯示格式 = **`BASE/QUOTE` 大寫 ASCII + 斜線** | 對齊 Pyth registry 命名、auditor 可讀、語意無歧義（`EUR/USD` = 1 EUR 值多少 USD）。緊湊型 `EURUSD` 省 1 byte 但犧牲可讀，gas 差異忽略。 |
| #7-G | **EUR/GBP cross pair 處理待 registry 確認** | 三個 USD-quoted pair 有直接 feed；**EUR/GBP 是交叉盤**。實作 plan 第一步查 Pyth feed registry：有直接 feed → 單 feed path；無 → 交叉推導 `EUR/GBP=(EUR/USD)÷(GBP/USD)`，讀兩 feed、相除、`publish_time=min(兩者)`、staleness 取較舊。 |

## 1. 範圍

**做**：純鏈下 Pyth FX client（TS lib）+ 單元測試 + spec/notes 文件更新 + Opt 1 roadmap。
**不做**（YAGNI / 留給 #8 / 留給合規客戶）：
- ❌ 鏈上 Pyth adapter、VAA `update_single_price_feed`（= Opt 1 roadmap）。
- ❌ 任何 Move source 改動（seam 已存在）。
- ❌ #8 的 batch / PTB 組裝 / D9 fallback 編排邏輯。

## 2. 放置

新增 `ts/` package = `@payroll-flow/orchestrator`（pnpm + tsc strict + vitest）。

```
ts/
  package.json            # pnpm, @pythnetwork/hermes-client, vitest, typescript
  tsconfig.json           # strict
  src/
    fx/
      pyth-client.ts      # getFxScalars + 純轉換
      feeds.ts            # FEEDS config map (pair -> Pyth feed id)
      types.ts            # FxPair, FxScalars, typed errors
  test/
    fx/
      pyth-client.test.ts # mock Hermes response，純轉換單測
```

#8 的 PTB builder 之後落在**同一 package**（共用 deps/config）。

## 3. 介面

```ts
// types.ts
export type FxPair = "EUR/USD" | "GBP/USD" | "JPY/USD" | "EUR/GBP";  // 由 FEEDS key 推導

export interface FxScalars {
  fx_pair: Uint8Array;              // UTF-8 of canonical label, e.g. "EUR/USD"
  fx_rate: bigint;                  // D9 fixed-point, u64 範圍
  fx_pyth_publish_time_ms: bigint;  // u64, ms (= 秒 × 1000)
}

export class InvalidFxPrice extends Error {}   // price <= 0
export class FxRateOverflow extends Error {}    // fx_rate > u64::MAX
export class UnknownFxPair extends Error {}     // pair 不在 FEEDS
export class FxFeedUnavailable extends Error {} // Hermes 無此 feed / 網路錯

// pyth-client.ts
export async function getFxScalars(pair: FxPair): Promise<FxScalars>;
```

回傳直接餵 #8 → `pay_one(fx_pair, fx_rate, fx_pyth_publish_time, clock)`。
`bigint` 全程保 u64 保真（JS number 精度不夠）。

> **[A] u64 序列化邊界（#8 預埋）**：`fx_rate` / `fx_pyth_publish_time_ms` 過 PTB **必走 `tx.pure.u64(bigint)` BCS**，不可降級 JS `number`（>2^53 截斷）。#7 回傳 `bigint` 即為強制此約定。

## 4. 單位/縮放契約（#7 核心，全可單測）

來源：Hermes latest price update（feed id → `{price: int, expo: int, publish_time: sec}`）。

> ⚠ **推測**：用 `@pythnetwork/hermes-client`（`HermesClient.getLatestPriceUpdates`）。實作前用 `sui-docs-query` / context7 驗當前 API 形狀與回傳欄位，不靠記憶。Feed id（hex）需從 Pyth feed registry 查實際值填入 `feeds.ts`，不可臆造。

轉換（純函式，與 IO 分離以便單測）：

1. **fx_rate** = `round(price × 10^(expo + 9))`
   - 以 bigint 做：`expo + 9 >= 0` → `price × 10^(expo+9)`；`< 0` → `price` 除以 `10^-(expo+9)` 並做 round-half-up。
   - 典型 expo = -8 → `fx_rate = price × 10`。
   - **assert** `0 < fx_rate <= 2^64 - 1`，否則 throw `FxRateOverflow`。
2. **fx_pyth_publish_time_ms** = `BigInt(publish_time_sec) * 1000n`
   - ← **修掉秒/ms 危害**（spec line 290：傳秒進 ms 欄位 → 看似 ~50 年 stale → `fx_stale` 永遠 true，污染 auditor 訊號）。
3. **fx_pair** = `new TextEncoder().encode(pair)`（canonical label UTF-8）。
4. **staleness 不在 client 判**：client 只傳真實 ms。D9 由 Move `is_fx_stale(clock, publish_time)` 判。client **不複製** 60s 邏輯（單一真相源在鏈上）。

> **[C] cross pair auditor 可重現性**：EUR/GBP 若走交叉推導，event 的 `"EUR/GBP"` label 不對應單一 Pyth feed id。audit 文件須記錄計算式 `EUR/GBP = (EUR/USD) ÷ (GBP/USD)`、兩 feed id、`publish_time=min`，使 auditor 能用兩個原始 feed 重現該 rate。

## 5. Red-team（reporting-only 但屬 Plan track 邊緣）

| 向量 | 防禦 |
|------|------|
| price ≤ 0（負/零價） | reject → `InvalidFxPrice` |
| expo 造成 `fx_rate > u64::MAX` | range assert → `FxRateOverflow` |
| publish_time = 0 / 未來時間 | 照傳真值（Move D9 自標 stale）；client **不竄改** |
| Hermes 無此 feed / 網路錯 | throw `FxFeedUnavailable`。**fail loud**；D9「best-available + mark stale」fallback 是 **#8** 職責，不混進純 client |
| 未知 pair（不在 FEEDS） | compile-time（type union）+ runtime `UnknownFxPair` |
| cross pair 兩 feed staleness 不一致（EUR/GBP，若交叉推導） | `publish_time = min(兩者)`、取較舊；除法分母（GBP/USD）≤0 → `InvalidFxPrice` |

## 6. 測試（mock HTTP，零真網路）

純轉換函式抽出後單測：
- expo 分支：-8 / -9 / -10（含 expo+9 < 0 的除法 round path）。
- 秒 → ms（×1000）。
- rounding（round-half-up 邊界）。
- u64 overflow → throw。
- price ≤ 0 → throw。
- pair → UTF-8 bytes 編碼正確。
- 未知 feed / Hermes 空回傳 → throw。
- （若 EUR/GBP 走交叉推導）兩 feed 相除、`publish_time=min`、分母≤0 reject。

Rule 9：每個 test 註明「為什麼」——單位/縮放錯 = auditor staleness 與 local-currency 記帳訊號失真（非崩潰，是靜默腐蝕）。

## 7. 文件更新

- **spec §7**：把 **fx_rate = D9 縮放契約**釘進去（現只有 ms unit-contract box，缺 scale）。
- **spec + move-notes roadmap**：加 **Opt 1 鏈上 adapter**——seam 簽名不變 = non-breaking upgrade，opt-in 給要 tamper-evident FX 的合規客戶。列出鏈上版額外成本（Pyth dep、每 payday VAA update、liveness）。
- **move-notes**：關閉「(原)待修清單 #1 fx 單位釘死」（#7 已落實 ms 轉換於 client）。

## 8. 成功準則

1. `pnpm test` 全綠，涵蓋 §6 全部分支。
2. `getFxScalars("EUR/USD")` 對 mock Hermes 回傳正確 D9 fx_rate + ms publish_time。
3. seam 對齊：回傳三欄位型別/語意可直接餵 `pay_one`。
4. 零 Move source 改動（`sui move test` 仍 71/71）。
5. spec §7 fx_rate scale 釘死；Opt 1 roadmap 入檔。
