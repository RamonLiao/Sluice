---
paths:
  - "frontend/**/*"
  - "**/*.tsx"
  - "**/*.jsx"
---
# Frontend Rules

## UI 開發 — 委派 Gemini CLI

純 UI 工作（元件樣式、layout、動畫、靜態頁面）優先委派給 Gemini CLI 執行，節省 Claude tokens。

### 適用範圍
- 新建 UI 元件（按鈕、卡片、表單、modal 等）
- 樣式調整、RWD、動畫
- 頁面 layout / 靜態頁面
- 元件重構（純 UI 層，不涉及商業邏輯）

### 不適用（由 Claude 處理）
- 涉及 API 串接、狀態管理、商業邏輯的元件
- Auth / 權限相關 UI
- 複雜的表單驗證邏輯
- 需要跨模組理解的重構

### 執行方式
1. 先讀取相關的現有程式碼和 `package.json`，確認框架與套件
2. 組裝 prompt，包含：任務描述、現有程式碼、專案 code style 要求
3. 透過 Bash 呼叫：
   ```bash
   gemini -p "<prompt>" -y
   ```
4. 檢查 Gemini 產出：確認檔案存在、語法正確、跑 `npx tsc --noEmit`（若為 TS 專案）
5. 如果產出品質不佳，由 Claude 直接修正，不反覆重試 Gemini

### Prompt 範本
```
你是前端 UI 開發專家。

## 任務
{任務描述}

## 專案資訊
- 框架：{React/Vue/Svelte/...}
- 樣式方案：{Tailwind/CSS Modules/styled-components/...}
- 語言：{TypeScript/JavaScript}

## 規則
- 遵守現有 code style
- 使用專案已安裝的套件，不要引入新依賴
- 直接修改/建立檔案，不要只輸出程式碼
- 元件必須支援基本的 accessibility（aria labels、keyboard nav）

## 現有程式碼
{相關檔案內容}
```

## Test 原則
- Unit-Test 和 Integration Test 完之後，一定要做 Monkey Testing，想辦法做極端測試，把程式玩壞。
