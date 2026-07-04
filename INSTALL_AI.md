# INSTALL_AI.md — AI 自駕安裝指令書 v0

> 這份檔案是寫給 **AI coding agent（例如 Claude Code）** 看的安裝腳本，不是給人逐步照抄的教學。
> 使用者只需要三步：
> 1. 裝好 Node.js（18+）與（可選）Claude CLI。
> 2. `git clone` 這個 repo。
> 3. 對 AI 說一句：「照 INSTALL_AI.md 幫我裝好」。
>
> 其餘的檢查、安裝、驗證、啟動 WebUI，全部由 AI 依本檔自駕完成。

---

## 0. 目標與安全契約（AI 執行前先讀，並全程遵守）

AI 在執行本檔時，必須把以下契約當成硬邊界，任何一條衝突就停下來回報使用者，不自行繞過：

- **只在本 repo 內動作**：所有讀寫都限制在這個 clone 出來的資料夾內；不碰資料夾以外的任何路徑。
- **不讀使用者私人檔案**：不讀 home 目錄、使用者設定檔、系統目錄、其他無關專案。
- **不把 secrets 進 git**：任何 token、chat id、私密路徑一律只寫進本機 `.env`（已被 `.gitignore` 忽略），永不 commit。
- **預設 mock、不自動開真 worker**：未經使用者明確確認前，保持 `MOCK_WORKER=1`，不啟用真 Claude worker。
- **不自動接 Telegram**：未經使用者明確確認前，不啟動 Telegram polling。
- **不設任何 bypass 權限旗標**：不設 `CLAUDE_BYPASS_APPROVALS`，不加 `--dangerously-skip-permissions`，除非使用者明確要求並理解風險。

一句話：**AI 是來幫忙自動化安裝與驗證，不是來替使用者做安全決策的。**

---

## 1. 支援路徑

| 項目 | 說明 |
|---|---|
| 作業系統 | **Windows-first**（已在 Windows 實測）；macOS / Linux 命令等價，路徑與 env 語法自行對應 |
| Node.js | 需要 **18 或以上**（`node --version` 驗證） |
| git | 需要（clone 這個 repo 時已用到） |
| Claude CLI | **可選**；不裝也能跑，因為預設是 **mock 模式** |
| 外部依賴 | 無（本 repo 零 npm 相依，`npm install` 為選填） |

**預設模式 = mock。** 這代表使用者第一次跑，不需要任何 API key、不需要 Claude 帳號、不需要 Telegram，就能看到完整的 task 生命週期跑通。

---

## 2. AI 安裝檢查清單（依序執行，逐項回報結果）

AI 請照下面順序做，每一步把實際輸出記下來，最後彙整進完成回報：

1. **確認 cwd**：確認目前工作目錄就是這個 repo 根目錄（能看到 `package.json`、`agent/`、`scripts/`）。若不在，先 `cd` 進來。
2. **驗版本**：
   ```bash
   node --version   # 必須 >= 18
   npm --version
   git --version
   ```
   Node.js 低於 18 就停下來回報，不自行升級系統 Node。
3. **建立 .env**：把 `.env.example` 複製成 `.env`。
   - bash / macOS / Linux：`cp .env.example .env`
   - Windows PowerShell：`Copy-Item .env.example .env`
4. **保持 mock**：確認 `.env` 內 `MOCK_WORKER=1`（`.env.example` 本來就是這個預設，通常不用改）。
5. **doctor 自檢**：
   ```bash
   npm run doctor
   ```
   會檢查 Node 版本、`data/tasks` 可建立、預設 port 是否可用。看到 `Doctor passed` 或只有 port WARN 即可繼續。
6. **跑 demo**：
   ```bash
   npm run demo
   ```
   這會用 mock worker 走完一次建立 task → 執行 → 寫 artifact 的流程。記下 demo 產生的 **task id** 與 **artifact 路徑**。
7. **驗 demo**：
   ```bash
   npm run verify-demo
   ```
   記下 verifier 的判定結果（verdict）。
8. **啟 WebUI 並回報網址**：
   ```bash
   npm run web
   ```
   啟動後回報可開啟的本機網址（預設 `http://127.0.0.1:3100`；若 `.env` 改過 `PORT`，用改後的值）。

> **Windows 環境變數提醒**：若要臨時換 port，PowerShell **不能**用 `PORT=3200 npm run web`，要寫成 `$env:PORT=3200; npm run web`。bash / macOS / Linux 才用 `PORT=3200 npm run web`。

---

## 3.（可選）啟用真 Claude worker

**前提：mock demo 已全部跑通**，且使用者明確表示要開真 worker。AI 才進行以下步驟：

1. 先確認 CLI 存在：
   ```bash
   claude --version
   ```
   沒裝或版本異常就停下回報，不自行安裝。
2. 在 `.env` 設 `ENABLE_REAL_CLAUDE_WORKER=1`（保持 `MOCK_WORKER` 由 real worker 旗標接手）。
3. 提醒使用者：真 worker 執行時，Claude CLI **會出現核可提示（approval prompt）**；這是正常的安全設計，不要為了跳過提示而去設 bypass 旗標。
4. 只有在使用者理解上述風險並確認後才啟動；否則維持 mock。

---

## 4.（可選）啟用 Telegram

Telegram 讓使用者可以「傳訊息進去、收結果回來」。**token 屬於使用者手動步驟，AI 只負責代驗設定一致性，不代替使用者去申請 bot。**

使用者手動步驟（AI 不代做）：
1. 在 Telegram 找 `@BotFather`，`/newbot` 建一個 bot，拿到 token。
2. 找 `@userinfobot` 拿到自己的數字 chat id。

AI 代驗步驟：
1. 確認 `.env` 內 `TG_BOT_TOKEN` 已填。
2. **檢查 `ADMIN_TG_CHAT_ID` 是否有填**——這是最常見的漏設。
   - 當 `TG_BOT_TOKEN` 有值但 `ADMIN_TG_CHAT_ID` 為空時，runtime 會**拒絕啟動 Telegram polling**。
   - 精確修法：在 `.env` 把 `ADMIN_TG_CHAT_ID=` 這行補上使用者的數字 chat id，例如 `ADMIN_TG_CHAT_ID=123456789`，存檔後重跑 `npm start`。
3. 確認兩者一致後，回報使用者可以傳訊息測試。

---

## 5. 完成回報模板（AI 裝完後照此彙整給使用者）

```text
✅ aiwff-runtime 安裝完成回報

repo 路徑：<clone 出來的絕對路徑>
模式：mock / real / TG（實際啟用哪個）
WebUI 網址：http://127.0.0.1:<port>
demo task id：<npm run demo 產生的 id>
artifact 路徑：<data/artifacts/<id>.result.md>
執行過的命令：
  - node --version / npm --version / git --version
  - cp .env.example .env（或 Copy-Item）
  - npm run doctor
  - npm run demo
  - npm run verify-demo
  - npm run web
未解警告：<例如 port WARN、Claude CLI 未裝、TG 未接>（沒有就寫「無」）
```

---

## 6. 疑難排解

| 症狀 | 可能原因 | 處理方式 |
|---|---|---|
| WebUI 起不來、port 被占 | 預設 port 已被其他程式占用 | doctor 會顯示 `WARN port ... in use`；換 port：bash `PORT=3200 npm run web`／PowerShell `$env:PORT=3200; npm run web` |
| doctor / demo 報 Node 版本錯 | Node.js 低於 18 | 停下回報使用者升級 Node 到 18+，AI 不自行動系統 Node |
| PowerShell 設 env 無效 | 用了 bash 的 `VAR=value cmd` 語法 | 改用 `$env:VAR='value'; cmd` |
| 跑完 demo 找不到 artifact | 沒看 demo 輸出裡的路徑，或 cwd 跑錯地方 | 確認 cwd 是 repo 根目錄；artifact 在 `data/artifacts/<task_id>.result.md` |
| Telegram 不啟動 | `TG_BOT_TOKEN` 有填但 `ADMIN_TG_CHAT_ID` 為空 | 補上數字 chat id（見第 4 節），存檔重跑；兩者要一致 |
| 真 worker 一直跳核可提示 | 這是正常安全設計 | 不要設 bypass 旗標去跳過；逐次核可，或先回 mock 模式驗證流程 |

---

## 附註

- 這份 v0 是自駕安裝草稿；預設走最安全的 mock 路徑，把「接真 worker」「接 Telegram」都放在使用者明確確認後的可選段。
- 詳細的架構、元件說明、`.env` 欄位完整表，見 `README.md` 與 `docs/architecture.md`。
