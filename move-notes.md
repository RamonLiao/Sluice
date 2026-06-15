# PayrollFlow — Move Notes

> 合約設計長期記錄。實作前先讀此檔 + `docs/specs/2026-05-30-payroll-flow-spec.md`。

## 目的
把 payroll run 變成單一 PTB:per-employee 原子完成 withholding → 多桶 allocation(Scallop-style 收益 +
Navi-style BTC-index + liquid)→ compliance event。Value conservation 靠 Move linear type 結構性成立。

## 鎖定決策(2026-05-30,binding)
- **D1** MVP 用 **testnet mock vault**,不接真實 Scallop/Navi。理由:Scallop 無 testnet(SDK mainnet-only)、
  Navi testnet 未驗證;接外部 mainnet 會把 demo 成敗綁在它們 uptime。
- **D2** Mock 要**鏡像兩種真實 deposit 模型**(見下),mainnet swap 才 drop-in。
- **D3** `AllocationCap` = 員工 owned 授權令牌;**ratios 存 shared `Payroll` registry**(owned object 不能被非
  owner 當 PTB input,payday 由雇主跑 → 必須讀得到)。Cap 只 gate「改 ratios」+「提領自己 position」。
- **D4** Employee 存 `Table<address, EmployeeRecord>` 內嵌於 shared `Payroll`。
- **D5** MVP 單雇主;`AllocationCap.payroll_id` 讓多雇主 = 多個 cap,schema 不鎖死。
- **D6** 單一 shared `TaxEscrow`,內含 `Table<jurisdiction, Balance<USDC>>`。
- **D7** Pyth FX **真接**(唯一保留的真實外部整合,有穩定 testnet feed)。
- **D8** Vault 掛掉**不 abort**:`route()` 讀 vault `active` flag,inactive → 該桶併入 liquid。
- **D9**(architect review 2026-05-30 新增)Stale FX **不 abort**。`fx_rate` 只進 `PayrollEventV1`
  (reporting/forensic),**不在 USDC 價值路徑**。>60s → event `fx_stale=true` + best-available rate,照發。
  理由:對只餵 event 的 oracle abort 全員薪資 = self-DoS,與 D8 哲學矛盾。`E_STALE_FX`(舊 #6)**移除且不重用**。
- **D10**(新增)反搶跑 staging 鍵綁 **payroll period counter**,不是 Sui epoch。epoch ~24h 自動推進、與發薪
  週期脫鉤 → 員工前一天改 ratios 隔天就生效,反搶跑失效。`Payroll.current_period`,雇主 `begin_period()`
  每次 payday +1 一次;`pay_one` 對單筆 record **lazy promote**(`current_period >= effective_from_period`),
  不掃整個 Table。欄位:`AllocationConfig.effective_from_period`(取代 `effective_from_epoch`)。
- **D11**(新增)shared object 加 `version: u64` + 每個 mutating entry `assert_version`(`E_WRONG_VERSION=9`)。
  保留 `UpgradeCap` 卻無版本閘 → 升級後舊 module 版本仍能改 shared object。升級流程:bump `VERSION` const +
  一次性 `migrate(&mut Payroll/TaxEscrow, &PayrollOwnerCap)` 設新版號。`Payroll` 與 `TaxEscrow` 都要加。

## 鏈上事實(已驗證原始碼,2026-05-30 — 勿用 gemini 給的 package/object ID,那是幻覺)
- **Scallop** `protocol::mint::mint<T>(version, market:&mut Market, coin:Coin<T>, clock, ctx): Coin<MarketCoin<T>>`
  — 回傳 sCoin(bearer receipt,PTB 可組合)。用 non-entry `mint`,不是 `mint_entry`。
  來源 `scallop-io/sui-lending-protocol` `contracts/protocol/sources/user/mint.move`。
- **Navi** `lending_core::incentive_v3::entry_deposit` / `deposit_with_account_cap` — **不回傳**。position 記在
  shared `Storage.user_info` / `TokenBalance.user_state: Table<address, u256>`(account/address-keyed)。
  來源 `naviprotocol/navi-smart-contracts` `lending_core/sources/{incentive_v3,lending,storage}.move`。
- **關鍵後果**:Navi 把 supply 記在 **tx sender** 名下;payday sender 是雇主 → 會違反「員工擁有收益」。
  Mock 用 **address-keyed + `beneficiary` 參數**繞過,忠實鏡像 Navi 底層 Table 記帳。

## Module 結構(無循環依賴)
```
vault_std            ← seam,deposit 介面契約
vaults::mock_scallop ← mint -> Coin<MockSCoin<T>>        (receipt-coin 模型)
vaults::mock_navi    ← deposit(beneficiary, coin)         (address-keyed,no return)
escrow               ← TaxEscrow
compliance           ← PayrollEventV1
allocation           ← AllocationCap, route()  (→ vault_std, escrow)
payroll              ← Payroll, pay_one()       (→ allocation, escrow, compliance)
```
實作順序前提:**先 `vault_std` + 兩個 mock vault**(其他模組依賴此 seam)。

## 鏈上限制 / 風險
- PTB 物件上限 → orchestrator batch ≤50 employees/PTB,>50 拆 N 個 PTB。
- FX <60s 新鮮度檢查**不 abort**(D9):stale → event `fx_stale=true`,照發。FX 只進 event,不在價值路徑。
- 高風險改動(storage 結構、abilities、物件生命週期)實作前先條列確認設計。

## 測試結果
- **TODO #1 seam 完成(2026-05-31)**:`move/` scaffold + `vault_std` + `mock_scallop` + `mock_navi` + `vaults_tests`。
  `sui move build` exit 0 / 0 warning;`sui move test` **10/10 PASS**(含 monkey:zero deposit、overdraw、
  非持有人提領、paused vault redeem/withdraw、重複存入累加、receipt 隨 clock 漲價)。
  - 實作細節落地:vault `active` 用 `is_active()` view 暴露給 `route()`(TODO #3)讀;`assert_active` 只守
    **直接 redeem/withdraw**,route 的 D8 fallback 要讀 flag 自行分流,**不要在 route 內呼叫 assert_active**。
  - `mock_navi::E_VAULT_PRINCIPAL=8` 對齊 spec §8;mock 自有 code:vault_std `E_VAULT_INACTIVE=100`、
    mock_scallop `E_ZERO_DEPOSIT=2`、mock_navi `E_NO_POSITION=9`。
  - Move const 不可跨 module 引用 → 測試 `expected_failure` 用 `abort_code=N, location=<module>` 綁定。
  - **review pipeline 已補跑(2026-06-15, move-code-quality → sui-security-guard 兩輪)**:0 critical / 0 new HIGH/MED。
    - quality:語法/命名/PTB composability/method 語法全過。3 建議皆延後 → Move.toml implicit framework dep、
      `#[error]` annotation(等 error 表全域定案)、`set_active`/`set_index_price` param order(checklist 要 mutable obj 先於 cap,併 #5 統一)。
    - security:secret scan clean;access control(cap.vault_id 綁定)、整數(scallop shares≤value 安全;navi reserves≥Σpositions 恆成立)、
      object lifecycle 全過;`deposit` 任意 beneficiary = 送錢非威脅(withdraw sender-keyed)。
    - LOW(已追蹤,不阻塞):①scallop 收益未真實 funded 早領排乾(LOW-2,mainnet swap 後複查) ②redeem `as u64` 截斷(LOW-3,精度定案加 assert)
      ③新增 accrue index 累加無上界(mock_scallop:76,實務不可達,併 LOW-3 處理)。
    - red-team 維持跳過:seam 非核心金流,withdraw 刻意非 cap-gated,核心攻擊向量留 #5 payroll。**可 commit。**
- **TODO #2 escrow 完成(2026-06-15)**:`sources/escrow.move` + `tests/escrow_tests.move`(13 test)。
  `sui move build` clean;`sui move test` **25/25 PASS**(13 escrow + 12 vaults)。
  - **3 項設計定案(與 spec 字面不同,已確認)**:
    1. `TaxEscrow<phantom T>` **generic**(非硬寫 USDC) → 配合 vault 慣例 + 好測,GTM 換型別引數即可。
    2. spec §5 `remit/migrate(cap:&PayrollOwnerCap)` 會造成 **循環依賴**(escrow 是 leaf,payroll→escrow)。
       → escrow 只暴露 `public(package)` 原語(`new/share/reserve/withdraw/migrate/assert_version`);
       **cap-gated `remit`/`migrate` wrapper 改在 `payroll` 模組(TODO #5)**。escrow 完全不碰 cap 型別。
    3. `reserve` 改 **`public(package)`**(spec 寫 public) → 防外部往任意 jurisdiction key 塞錢污染 bucket。
  - 錯誤碼:`EWrongVersion=9`(對齊 spec 全域 D11)、`ENotUpgrade=10`、`EUnknownJurisdiction=101`、
    `EInsufficientEscrow=102`(後二者 module-local 100+,比照 vault,避開 payroll-global §8 碼)。
  - **⚠ HIGH 設計約束轉 TODO #5**:escrow `withdraw`/`migrate` **本身無授權**,安全 100% 依賴 payroll
    wrapper 先驗 `&PayrollOwnerCap`。同 package 任何 module 都能無 cap 抽乾 escrow。
    → 寫 payroll 時 `remit` 必須先 `assert!(cap.payroll_id==...)` 再呼叫 `escrow::withdraw`,
    且不得在他處暴露無 cap 的 withdraw 路徑。**red-team 留到 payroll 階段針對「未授權 remit / cap 偽造」驗。**
  - test_only helper:`new_for_testing`/`package_version`/`set_version_for_testing`(模擬 pre-upgrade 物件)。
- **TODO #3 allocation 完成(2026-06-15)**:`sources/allocation.move` + `tests/allocation_tests.move`(12 test)。
  `sui move build` clean;`sui move test` **37/37 PASS**(12 allocation + 13 escrow + 12 vaults)。三輪 review
  (move-code-quality → sui-security-guard → sui-red-team 4 rounds 全 DEFENDED)。
  - **設計定案(已確認,含 2 處與 spec 字面不同)**:
    1. **同 escrow 的循環依賴破解**:spec §5 `set_ratios/pause(payroll:&mut Payroll, cap:&AllocationCap)`
       會造成 `allocation→payroll` cycle(graph 是 payroll→allocation)。→ allocation 只暴露 `public(package)`
       原語操作 `AllocationConfig`(內嵌於 `EmployeeRecord`);**cap-gated `set_ratios`/`pause` wrapper 改在
       `payroll`(TODO #5)**。allocation 完全不碰 `Payroll`/cap 比對。
    2. **砍掉 spec 的 `AllocationConfig.effective_from_period` 頂層欄位**(冗餘):effective period 只屬於
       `pending`(`PendingRatios.effective_from_period`)。committed ratios 永遠是 live。
    3. **`route` 回傳 `(Coin<T>, u64 scallop_amt, u64 navi_amt)`** 非只 `Coin`:`pay_one` 要「實際」存入額
       填 `PayrollEventV1`(D8 paused 時 actual≠intended,event 必須誠實)。
  - **D10 staging**:`stage_ratios` 驗 Σ==10000(`ERatiosSum=4`)後設 pending @ `current_period+1`;
    `promote_if_due` 對單筆 record lazy promote(O(1),不掃 Table);last-write-wins 覆蓋未 promote 的 pending。
  - **D8 fallback = remainder 數學**:liquid 是 `net` split 後的自然餘額,paused vault 的 bucket 不 split-out →
    留在 net → 回傳成 liquid,該 bucket 報 0。value conservation 結構性成立(linear Coin),非 assert 算術。
  - `route` generic over `T`,依賴具體 mock vault 型別;mainnet swap 換 mock body、簽章不動(spec §3.2/§12)。
    無 version 欄位:`AllocationConfig` 由外層 `Payroll` 的 `assert_version`(D11)守(payroll 階段)。
  - 錯誤碼:只用 `ERatiosSum=4`(對齊 spec §8);`E_NOT_ALLOCATION_OWNER=2` 的 cap↔record 比對在 payroll wrapper。
  - **⚠ 設計約束轉 TODO #5**:`stage_ratios`/`stage_pause`/`route` 皆 `public(package)` **無 cap 檢查**,
    auth 100% 靠 payroll wrapper 先驗 `AllocationCap` ↔ `EmployeeRecord`(`cap_payroll_id`/`cap_employee` accessor)。
    紅隊「未授權 mutation / 偽造 cap」在 allocation 層 **無 public surface 不可達**,留到 payroll 階段驗。
  - test_only helper:`new_cap_for_testing`/`default_config_for_testing`。
- **TODO #4 compliance 完成(2026-06-15)**:`sources/compliance.move` + `tests/compliance_tests.move`(9 test)。
  `sui move build` clean;`sui move test` **46/46 PASS**(9 compliance + 12 allocation + 13 escrow + 12 vaults)。
  review 兩輪(move-code-quality → sui-security-guard,皆 0 critical/HIGH/MED,verdict commit y)。
  - **設計定案**:leaf module(payroll → compliance),純 event emission,**無 shared state / 無 cap / 無 UID**,
    故**無 version 欄位 / 不需 assert_version**(D11)——沒有 shared object 要守,enclosing `Payroll` 在 payroll 層先驗版號。
  - `PayrollEventV1` 完全照 spec §7 欄位(copy, drop,no key);`emit_payroll_event_v1` = `public(package)`,
    只有 payroll 能 emit → 防外部偽造 event。
  - **防呆 sum-check(Rule 12 fail-loud)**:emit 前 assert(widen u128)`net == liquid+scallop+navi`
    且 `gross == withholding + net`,帳不平就 abort 不發假 receipt。錯誤碼 `ESumMismatch=100`(module-local,
    比照 escrow/allocation 100+;非 spec §8 user error,是 internal「不該發生」guard)。
  - `fx_rate`/`fx_pair`/`fx_pyth_publish_time`/`fx_stale` = D9 reporting-only pass-through,不在價值路徑、不被 assert。
  - test_only:`new_for_testing` + 11 個 `event_*` field getter(測 struct wiring,不依賴 event-capture 內部)。
    monkey:gross=0、100% withholding、單桶 liquid、u64::MAX 不溢位、兩條 abort path、stale FX pass-through。
  - red-team 跳過(同 escrow seam 理由):無 auth/mutation/shared state,無攻擊面;核心金流紅隊留 #5 payroll。
  - 延後(同前):`#[error]` annotation、Move.toml 顯式依賴(等全域定案統一)。
- 其餘模組實作後跑 `sui move test` + monkey test(gross=0、withholding=100%、ratios 單桶、
  funding 剛好等於 Σgross、50-employee 邊界、paused 員工)再 commit。

## 已知風險 / GTM 前 open task
1. **Navi mainnet 代員工存入**:per-employee `AccountCap` 存 registry vs sponsored/co-signed deposit?未決。
2. **mock USDC type → mainnet canonical USDC type** 切換點。
3. 上述兩者解掉前不可上 mainnet。
