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
- **TODO #5 payroll 完成(2026-06-15)**:`sources/payroll.move` + `tests/payroll_tests.move`(20 test)。
  `sui move build` clean(0 warning,1 suppressed);`sui move test` **66/66 PASS**。root module,auth 收口層,
  review 三輪(move-code-quality → sui-security-guard → sui-red-team 10 rounds)+ 修完再驗一輪,verdict commit y。
  - **3 項設計定案(與 spec 字面不同,沿用 #2/#3 已核准模式)**:
    1. `Payroll<phantom T>` **generic**(spec 寫死 `Balance<USDC>`)——配合 escrow/allocation/vault 全 generic,GTM 換型別引數。
    2. **FX scalar seam**(spec 寫 `price: &PythPrice`)——Pyth 是 TODO #7 未整合。`pay_one` 收
       `(fx_pair, fx_rate, fx_pyth_publish_time, clock)`,module 內算 `fx_stale = now_ms-pub_ms > 60_000`(D9)。
       TODO #7 只需包 Pyth→這些 scalar,簽章不動。**⚠ publish_time 約定為 ms**(配合 clock.timestamp_ms)。
    3. `add_employee` 直接 `transfer` AllocationCap 給員工(spec 簽章 return)——entry-friendly。
  - **#2/#3 轉嫁的 HIGH auth 約束全部收口**:`assert_owner`(雙向:`object::id(cap)==owner_cap_id` 且
    `cap.payroll_id==object::id(payroll)`)gate fund/add/set_gross/begin_period/pay_one/remit/migrate;
    `assert_alloc_owner`(三重:cap_payroll_id + cap_employee + `record.allocation_cap_id==object::id(cap)`)
    gate set_ratios/pause。物件 id 比對是 load-bearing(欄位相同但 id 不同的偽造 cap 被擋)。
  - **review 抓到 2 個真 bug,已修(非 tracked debt,當場收口)**:
    1. **escrow 未綁定 payroll**(security MED-2 / red-team round3):remit/migrate/pay_one 收任意 `TaxEscrow<T>`,
       cap 只 gate「誰」不 gate「哪個 escrow」→ 多租戶(D5/D6)可跨租戶 drain。
       **修**:`Payroll` 加 `escrow_id: ID`(create 時綁),三函式 assert `object::id(escrow)==escrow_id`,
       新碼 `EWrongEscrow=12`。**vault 故意不綁**(mainnet Scallop/Navi 是全域 singleton,綁了反而錯)。
    2. **同期重複付款**(red-team round5):無 idempotency guard。**修**:`EmployeeRecord.last_paid_period`,
       `pay_one` assert `last_paid_period < period` 後設值,新碼 `EAlreadyPaidThisPeriod=11`。
       **副作用(正確)**:付款需 period≥1 → 強制「先 begin_period 開薪資期才能付」,period 0 付款無效業務狀態。
       >50 員工多 PTB 同期 payday 仍安全:guard 是 per-record 非 per-period-global,每人恰付一次,重跑 chunk 自動擋已付。
  - 錯誤碼:全用 spec §8 payroll-global(1/2/3/5/7/9)+ 延續序號 10(ENotUpgrade)/11(EAlreadyPaidThisPeriod)/
    12(EWrongEscrow)。`VERSION=1`,`assert_version` gate 每個 mutating entry(migrate 除外——它是修版號的)。
  - value conservation 結構性(linear split chain:`funding.split(gross)→.split(wh)→route(net)`);
    compliance u128 sum-check 是 fail-loud 雙保險(Rule 12)。借用衛生:record 欄位先 copy 出再碰 `payroll.funding`(disjoint-field)。
  - test_only:`create_payroll_for_testing`(鏡像 create,建+share 綁定 escrow)、`set_version_for_testing`、`package_version`。
    紅隊回歸:`double_pay_same_period_aborts`(11)、`pay_one_foreign_escrow_rejected`(12)、`pay_at_period_zero_aborts`(11)。
  - **⚠ commit 尚未做**(非 git repo);#1–#5 全未 commit,待 user 決定。
- 其餘模組實作後跑 `sui move test` + monkey test(gross=0、withholding=100%、ratios 單桶、
  funding 剛好等於 Σgross、50-employee 邊界、paused 員工)再 commit。

## 全package 架構 review(sui-architect,2026-06-16,組裝後成品審查)
> Verdict:**MVP/testnet sound**,無 CRITICAL/HIGH 阻擋 TS orchestrator。所有 finding 皆 doc/planning 級,**code 不動**。
> OK 驗證通過:acyclic DAG、cycle-break pattern 五模組一致、generic T 端到端無洩漏(USDC swap 確認單點)、
> sum-check invariant 完整、D11 版本閘兩 shared object 一致。

**✅ 全 5 項已修(2026-06-16,純文件,無 code 改動):**
- #1 fx 單位 → spec §7 加「FX unit contract」warning box(ms end-to-end,#7/#8 餵 ms;code 端 line 39/324 早已釘)。
- #2 依賴圖 → `module-dependency.mmd` 砍假邊 `allocation→{escrow,vault_std}`、補真邊 `payroll/allocation→{mock_scallop,mock_navi}`;spec §2 prose 同步(實測 import 驗證)。
- #3 migrate invariant → spec §12 加「Payroll⇔escrow migrate together」(escrow_id bind,兩 shared obj 同 release 一起 migrate)。
- #4 vault-ID trust → spec §12 加 operator invariant(orchestrator 必傳 canonical vault ID)。
- #5 spec §2 誠實化 → vault_std 非通用 interface,兩槽硬接,加第三 venue 是簽章破壞(D11 upgrade,非 body swap)。

**(原)待修清單(留存):**
1. **[LOW 但會咬人] fx 單位釘死** — `payroll::is_fx_stale` 把 `fx_pyth_publish_time` 當 **ms** 比(對 `clock.timestamp_ms()`),
   但 Pyth 原生 `publish_time` 是**秒**。D9 保護價值路徑不會壞錢,但會讓 auditor staleness 訊號失真。
   → **#7 Pyth 整合前**必須在 spec §7 欄位註解 + TODO #7 contract 明寫單位約定(orchestrator 餵 ms)。
2. **[LOW] 依賴圖/spec §2 prose drift** — `module-dependency.mmd` 寫了**假邊** `allocation→escrow`(實際 allocation 沒 import escrow,只有 payroll 有),
   且漏真邊 `allocation→{mock_scallop,mock_navi}`、`payroll→{mock_scallop,mock_navi}`。→ 修圖 + 修 spec §2 文字(會誤導 GTM swap 規劃)。
3. **[MED] migrate 跨物件耦合記成 invariant** — Payroll+escrow 同時 migrate 的安全性隱性靠 `escrow_id` bind +
   兩者都是 migrate 必填參數。正確但未文件化。→ 在 spec/notes 明寫「Payroll 與其 escrow 永遠一起 migrate」為 migrate invariant。
4. **[MED] vault 未綁 = orchestrator 信任面** — vault 故意不綁(mainnet singleton 正確),但 `pay_one` 收任意同型 vault,無鏈上 guard。
   → #8 orchestrator 規範:必須傳 canonical scallop/navi vault ID。記為 operator invariant(非 code fix)。
5. **[MED] spec §2 高估 `vault_std` 可擴展性** — `route`/`pay_one` 把恰好 2 個 venue 寫死進簽章;加第三個 venue 是簽章破壞,非 body swap。
   → 修 spec §2 措辭誠實化(MVP 兩槽硬接,非通用 interface)。

## 已知風險 / GTM 前 open task
1. **Navi mainnet 代員工存入**:per-employee `AccountCap` 存 registry vs sponsored/co-signed deposit?未決。
   **⚠ 架構 review 補充(HIGH, mainnet only)**:Navi mock 的 `beneficiary: address` 參數在真 Navi **無對應**(真 Navi 記 `ctx.sender()`/`AccountCap`),
   payday sender=雇主 → Navi seam **不是純 body swap**,需改 `EmployeeRecord` schema(存 AccountCap)→ 等於一次 **D11 schema-migrating upgrade**,非熱替換。
   Scallop seam 才是真 drop-in(`mint` 回 `Coin<MarketCoin<T>>` 同形)。GTM 規劃必須把 Navi-mainnet 當 upgrade event 處理。
2. **mock USDC type → mainnet canonical USDC type** 切換點(已確認:單點 call-site 改動,非 code 改動)。
3. 上述兩者解掉前不可上 mainnet。
