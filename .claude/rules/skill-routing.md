# SUI Skill Routing

- 本檔只在處理 Sui Move / 合約相關工作時適用。
- 遇到對應任務時，**必須先調用對應的 skill**，不要跳過直接寫 code。

## 路由表

| 任務 | Skill |
|------|-------|
| Move 合約開發 | `sui-developer`（含品質檢查） |
| Move 測試 | `sui-tester`（含 gas tracking） |
| SUI 架構設計 | `sui-architect` |
| 部署（devnet→testnet→mainnet） | `sui-deployer` |
| 安全審計 | `sui-security-guard` + `sui-red-team` |
| Move 程式碼品質檢查 | `move-code-quality` |
| SUI SDK/CLI 疑問 | `sui-docs-query`（先查最新文件，不依賴過期資訊） |
| Seal 加密 / threshold encryption / 資料存取控制 | `sui-seal` |
| Kiosk NFT | `sui-kiosk` |
| DeepBook DEX | `sui-deepbook` |
| 鏈上合約反編譯/分析 | `sui-decompile` |
| SuiNS 域名 | `sui-suins` |
| 跨鏈橋接 / 鏈下驗證計算 | `sui-nautilus` |
| 自定義 indexer / data pipeline | `sui-indexer` |
| Gas 分析優化 | `sui-dev-agents:gas` |

## 複合任務（有 fullstack 時追加）

| 任務 | Skill |
|------|-------|
| 前端 dApp | `sui-frontend` + `sui-ts-sdk` |
| zkLogin | `sui-zklogin` |
| Passkey | `sui-passkey` |
| 前後端整合 / TS type generation | `sui-fullstack-integration` |

## Code Review Override（重要）

**禁止對 Move/.move 檔案使用 `superpowers:code-reviewer`（generic reviewer）。**

當觸發 code review（包含 `requesting-code-review`、`subagent-driven-development` 的 review step）時：

| 審查對象 | 替代方案（按順序執行） |
|---------|----------------------|
| Move 合約 (.move) | 1. `move-code-quality`（Move Book 50+ 規則）→ 2. `sui-security-guard`（安全掃描）→ 3. `sui-red-team`（核心合約才需要） |
| SUI 全端架構 | `sui-architect`（spec 驗證 + SUI best practices） |
| 前端 dApp (SUI 整合) | `sui-frontend` review + generic reviewer 可輔助 |
| 非 Move 的 TypeScript/NestJS | generic `superpowers:code-reviewer` 可用 |

### 執行方式

- **不要** dispatch `superpowers:code-reviewer` 來審 Move code — 它不懂 Move 語法、abilities、object model。
- 用 `/sui-dev-agents:audit` 做完整安全審計。
- Architecture review 必須用 `sui-architect` skill 驗證設計是否符合 SUI best practices（object model、shared vs owned、upgradeability）。
- 如果 subagent-driven-development 要求 review，對 Move 部分改用上述 SUI skills 替代。

## Build & Test

- Move 改動後必跑 `sui move test` 再 commit
- 部署前跑 `sui move build` 確認無錯誤

## Red Team (Move Contracts)

- 核心合約（auth、金流、access control）→ 用 `sui-red-team` skill
- 列出 ≤5 攻擊向量：access control bypass、integer overflow、object manipulation、economic exploit、DoS
