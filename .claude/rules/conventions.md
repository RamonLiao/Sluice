# Sui Move Rules

- 本檔只在處理 Sui Move / 合約相關工作時適用（例如 `move/`、`sui/` 或合約測試）。

## 任務切分

- 一個 chat 只處理一個 Move 任務：單一 module 功能、單一 bug、單一升級或遷移步驟。
- 任務完成後，主動建議：
  - 把變更摘要寫入 `move-notes.md`（目的、修改的 module、鏈上限制、測試結果、已知風險）。
  - 較長的調整流程，額外更新或建立 `move-task-log.md` 記錄步驟與踩雷。
  - 提醒我開新 chat 做下一個 Move 任務。
- 合約設計討論、鏈上遷移策略等長期資訊 → 寫入 notes 檔，不只留在 chat。

## Context 使用

- 任務開始時只讀：
  1. 與該 module 相關的 Move 檔案。
  2. `move-notes.md`（及必要時的 `move-task-log.md`）。
- 不要主動讀整個專案或所有 Move 檔；若需要更多檔案，先詢問我要哪些路徑。
- 若同一 chat 已牽涉多個無關 Move 任務，提醒我先更新 notes 再開新 chat。

## 修改與測試

- 優先提供局部 patch 或函式 / module 內部調整，不要整檔重寫，除非明確要求。
- 對 storage 結構、能力（abilities）、物件生命週期等高風險修改，先用條列方式向我確認設計。
- 每次功能新增或 bug fix，主動建議或產生對應的 Move 測試（單元或 e2e），並說明如何執行。

## 用量與安全

- 避免在同一 chat 中同時處理太多鏈上遷移、schema 改動與前端/後端配套；應拆成多個 chat + 多次 notes 更新。
- 若偵測到重複嘗試同一個失敗測試或無法通過的鏈上操作，先總結目前嘗試過的方案寫入 `move-notes.md`，再討論新策略，不要盲目重試。
