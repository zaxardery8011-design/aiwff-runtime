# aiwff-runtime（繁體中文說明）

> 英文完整版 → [README.md](README.md)

**裝在你自己電腦上的小型 AI 主腦——丟任務給它、背景跑完、結果推回來，瀏覽器看進度。**

它不是又一個聊天視窗，而是一個跑在你本機的 agent runtime：你交代一件事，它會自己建立任務、呼叫 Claude、把過程與結果寫成檔案，做完通知你。

## 不是什麼／是什麼

| 不是這樣 | 而是這樣 |
|---|---|
| ✗ 回一句就結束的聊天機器人 | ✓ 會建任務、跑 Claude、寫檔、回報完成的本機 agent 迴圈 |
| ✗ 包一層 UI 的雲端聊天 API | ✓ 用你的電腦、你的檔案、你本機 Claude CLI 的檔案型 runtime |
| ✗ 每條路線都要事先畫好的固定流程 | ✓ 一個任務佇列，Claude 在邊界內自己規劃、用工具 |
| ✗ 任務狀態存在別人伺服器的 SaaS | ✓ 全部留在本機：daemon、檔案匯流排、WebUI、記憶檔 |

一句話流程：

```text
你交代一件事
  -> 本機 daemon 建立一個 task
  -> Claude CLI 讀 CLAUDE.md 執行
  -> 結果寫進 data/artifacts/
  -> 瀏覽器（與可選的 Telegram）看得到結果
```

## 三步快速開始（推薦：讓 AI 幫你裝）

**① 準備環境**：裝好 Node.js 18+（`node --version` 驗證），Claude CLI 為可選（不裝也能跑）。

**② 取得程式**：

```bash
git clone https://github.com/zaxardery8011-design/aiwff-runtime
cd aiwff-runtime
```

**③ 對你的 AI coding agent 說一句話**：

> 「照 INSTALL_AI.md 幫我裝好」

接著檢查環境、安裝、驗證、啟動 WebUI 全部由 AI 自駕完成，細節見 [INSTALL_AI.md](INSTALL_AI.md)。

> **重點：預設是 mock 模式。** 第一次跑**不需要任何 API key、不需要帳號、不需要 Telegram**，就能看到一次完整的「建任務 → 執行 → 寫結果」跑通。

## 不想用 AI 裝？手動五命令版

```bash
npm run doctor        # 自檢：Node 版本、data 目錄、port
npm run demo          # 用 mock worker 跑完一次任務生命週期
npm run verify-demo   # 驗證上一步的產出
npm run web           # 啟動 WebUI（預設 http://127.0.0.1:3100）
npm start             # 完整啟動（含 Telegram，需先設定 .env）
```

> **Windows PowerShell 換 port**：不能用 `PORT=3200 npm run web`，要寫成 `$env:PORT=3200; npm run web`；bash / macOS / Linux 才用 `PORT=3200 npm run web`。

## 人格範本：貼進 CLAUDE.md 就有個性

不想對著空白的 `CLAUDE.md` 發呆？[`templates/claude/`](templates/claude/) 準備了幾套現成人格（開發夥伴／研究助理／生活秘書）——挑一套、把內容複製進你 repo 根目錄的 `CLAUDE.md`，助理就照那個個性回應你。

## 進階（做完 mock demo、確認要開再往下）

### 真 Claude worker

確認 `claude --version` 可用後，在 `.env` 設 `ENABLE_REAL_CLAUDE_WORKER=1` 換成真 worker。真 worker 執行時 Claude CLI 會跳核可提示，這是正常安全設計，別為了跳過而設 bypass 旗標。完整步驟見 INSTALL_AI.md 第 3 節。

### Telegram（傳訊息進去、收結果回來）

用 `@BotFather` 建 bot 拿 token、用 `@userinfobot` 拿自己的數字 chat id，兩者填進 `.env` 的 `TG_BOT_TOKEN` 與 `ADMIN_TG_CHAT_ID`。最常見的漏設是 chat id 留空——這時 runtime 會拒絕啟動 Telegram。此路採 polling，不需要 webhook 或公開 IP。完整步驟見 INSTALL_AI.md 第 4 節。

## 誠實的限制

這些限制刻意不美化：

| 限制 | 說明 |
|---|---|
| 單用戶設計 | 一個 Telegram bot 只綁一個管理員 chat id，不適合多人共用 |
| 只跑單台機器 | 沒有多節點派工，就是你這台電腦上的一個 agent 迴圈 |
| 記憶是文字注入非 RAG | 記憶量大時 context 會撐大，建議定期整理 `memory/` 下的檔案 |
| 不適合超長任務 | 超過約 10 分鐘的任務沒有斷點續傳機制 |
| Windows PATH | 用真 Claude worker 時，要確認 PATH 找得到 `claude.cmd` |

## 授權

MIT

