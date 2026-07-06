# 小主腦 安裝手冊

> 小主腦（專案名 `aiwff-runtime`）＝裝在你自己電腦上的小型 AI 主腦：丟一件事給它，它在背景把任務跑完，結果推回來，瀏覽器看得到進度。
>
> 這份是**安裝手冊**，教你怎麼把它裝起來、跑通第一次。學會裝好之後怎麼「用」它，見 [使用手冊 usage.md](usage.md)。
> 英文完整規格 → [../../README.md](../../README.md)。

---

## §0 開始之前（這份手冊給誰、你會得到什麼）

**這份手冊給誰**

- 你想要一個**跑在自己電腦上**的 AI 任務助手，而不是又一個雲端聊天視窗。
- 你會用基本的命令列（會開終端機、會複製貼上命令就夠了）。
- 你**不需要**先懂多節點、伺服器、雲端部署——小主腦刻意只跑在你這一台機器上。

**你裝完會得到什麼**

- 一個本機常駐程式（daemon），負責建立任務、跑 worker、把結果寫成檔案。
- 一個瀏覽器控制台（WebUI，預設 `http://127.0.0.1:3100`），看任務狀態與產出。
- 一條完整跑通的「建任務 → 執行 → 寫結果」流程，全部留在你本機的檔案裡（`data/` 目錄下）。
- （可選）接上 Telegram，之後可以用手機傳訊息丟任務、收結果。

**先講最重要的一句：預設就能免費跑通。** 第一次安裝走的是 **mock（模擬）模式**，不需要任何 API key、不需要付費帳號、不需要 Telegram，就能看到一次完整的任務生命週期。要不要接「會真的呼叫 AI」的付費模式，是你**跑通 mock 之後**才需要做的選擇——費用怎麼算，下一節 §1 先講清楚，不讓你裝到一半才發現要付錢。

**這份手冊的路線圖**

| 章節 | 內容 | 你現在需要嗎 |
|---|---|---|
| §0 開始之前 | 你在讀的這節 | 是 |
| §1 前置需求與費用說明 | 要準備什麼、哪些免費哪些要付費 | 是（裝之前一定要看） |
| §2 mock 安裝與驗證 | 一步步把免費模式跑通 | 是 |
| §3 啟用真 Claude worker | 接付費 AI、費用與核可提示 | 之後想升級再看 |
| §4 啟用 Telegram | 用手機傳訊息操作 | 之後想接手機再看 |
| §5 疑難排解與支援管道 | 卡住了怎麼辦、去哪求助 | 是 |

---

## §1 前置需求與費用說明（裝之前一定要先看）

### 1.1 你需要準備的東西

| 項目 | 需要嗎 | 怎麼確認 | 備註 |
|---|---|---|---|
| **Node.js 18 或以上** | ✅ 必要 | 終端機打 `node --version`，要 ≥ v18 | 唯一的硬需求。低於 18 請先升級 Node，本工具不會幫你動系統 Node |
| **git** | ✅ 必要 | `git --version` | 用來把程式抓下來（clone） |
| **npm** | ✅ 隨 Node.js 附帶 | `npm --version` | 裝 Node 就有；本專案**零外部相依**，`npm install` 是選填的 |
| **Claude CLI** | ⬜ 可選 | `claude --version` | **只有要跑「真 AI」時才需要**；不裝也能跑 mock 模式 |
| **Claude 付費訂閱** | ⬜ 可選 | 見 §1.3 | 同上，只有真 worker 模式才需要 |
| **Telegram Bot Token** | ⬜ 可選 | 見 §4 | 只有想用手機傳訊息時才需要 |

一句話：**只要有 Node.js 18+ 和 git，你就能免費把小主腦跑通。** 其他都是之後想升級才碰的。

### 1.2 兩種執行模式（先搞懂差別，再決定要不要花錢）

小主腦有兩種「大腦」可以用：

| 模式 | 誰在跑任務 | 要花錢嗎 | 適合 |
|---|---|---|---|
| **mock（模擬）模式** — 預設 | 內建的假 worker，走完整流程但不真的呼叫 AI | ❌ 完全免費 | 第一次安裝、驗證流程跑得通、看懂檔案長怎樣 |
| **real（真 Claude）模式** | 你本機的 Claude CLI，真的呼叫 Claude 執行 | ✅ 需要 Claude 付費訂閱 | 確認流程 OK 後，想讓它真的幫你做事 |

預設 `.env` 裡 `MOCK_WORKER=1`，也就是**開箱即 mock**。你要主動去開真 worker（見 §3），它才會花到錢——不會偷偷幫你切換。

### 1.3 費用誠實說明（重點，不藏）

> **真 Claude worker 需要付費的 Claude 訂閱。沒有訂閱，你只能跑 mock 模式。** 這件事在你裝之前就該知道，不是裝完才發現。

- 小主腦本身是 **MIT 授權、免費開源**，程式零外部相依，下載和跑 mock **不花一毛錢**。
- 但「真 worker」是叫用你本機的 **Claude CLI**，而 Claude CLI 要能真的執行，背後需要一個**付費的 Claude 訂閱帳號**登入。
- 費用層級與方案名稱會由 Anthropic 調整，本文不寫死價格。實務上你需要一個能使用 Claude CLI 的付費 Claude 帳號；輕量個人使用通常從入門付費方案評估，較高用量或較長任務再評估高用量方案。實際可用額度、價格與 CLI 權限，以你帳號當下顯示的官方資訊為準。
- **沒有訂閱怎麼辦？** 完全沒問題——**mock 模式永遠免費**，你可以用它把整套流程、WebUI、檔案格式全部摸熟，只是任務結果是模擬產物、不是真的 AI output。

> 小提醒：這裡不列死板價格數字，是因為訂閱方案與定價由 Anthropic 官方調整，寫死容易過時誤導。**要接真 worker 前，請先到 Anthropic 官網確認當前方案與價格**。

### 1.4 安全前提（一開始就講清楚）

- 你的任何密鑰（Telegram token、chat id）只會寫進本機 `.env`，這個檔已被 `.gitignore` 忽略，**不會進 git、不會外流**。
- 預設不接 Telegram、不開真 worker、不設任何「跳過核可」的旗標——這些都要你**主動確認**才會啟用。
- 如果你用 AI coding agent 幫你裝（見 §2），它遵循的安全契約寫在專案根目錄的 [`INSTALL_AI.md`](../../INSTALL_AI.md)：只在 repo 內動作、不讀你私人檔案、不把 secrets 進 git。

---

## §2 mock 安裝與驗證

跟著下面七步走，你會在**不花任何錢、不接任何帳號**的情況下，把一次完整的任務跑通。每步都附「你會看到什麼」，對不上就往 §5 找。

> 下面的命令與輸出，是在一台**乾淨環境**（全新 clone、沒有舊 `.env`、沒有舊 `data/`）實測記錄的。你機器上的 task id、時間戳、port 號會不一樣，但**輸出的形狀**應該一致。

### 步驟 1：把程式抓下來（clone）

```bash
git clone https://github.com/zaxardery8011-design/aiwff-runtime
cd aiwff-runtime
```

你會看到 `Cloning into 'aiwff-runtime'... done.`，然後多出一個 `aiwff-runtime` 資料夾。**之後所有命令都在這個資料夾裡跑**（先 `cd` 進來）。

### 步驟 2：確認環境版本

```bash
node --version   # 要 >= v18
npm --version
git --version
```

實測輸出（你的數字可能不同，只要 Node 是 18 以上就行）：

```text
v22.16.0
10.9.2
git version 2.54.0.windows.1
```

Node 低於 v18 就先去 [Node.js 官網](https://nodejs.org/) 升級，再回來。本工具**不會**幫你動系統 Node。

### 步驟 3：建立 `.env` 設定檔

把範例檔複製成 `.env`：

- **Windows PowerShell**：`Copy-Item .env.example .env`
- **bash / macOS / Linux**：`cp .env.example .env`

複製完的 `.env` 裡，`MOCK_WORKER=1`、`PORT=3100` 已經是預設值，**mock 模式開箱即用，不用改任何一行**。Telegram 與真 worker 的欄位都留空，代表都不啟用（要開再看 §3、§4）。

### 步驟 4：（可選）`npm install`

本專案**零外部相依**，這步是選填的。跑了也只會確認沒有東西要裝：

```bash
npm install
```

實測輸出：

```text
up to date, audited 1 package in 17s

found 0 vulnerabilities
```

看到 `audited 1 package`（就是專案自己）＋ `0 vulnerabilities`，代表「免相依」這句是真的。想省事，這步可以直接跳過。

### 步驟 5：自檢（doctor）

```bash
npm run doctor
```

doctor 會檢查三件事：Node 版本、`data/tasks` 能不能建立、預設 port 3100 有沒有被占用。**全綠**時你會看到：

```text
PASS Node.js version v22.16.0 >= 18
PASS data/tasks can be created at data\tasks
PASS port 3100 is available
✓ Doctor passed — ready to run demo
```

如果 port 3100 剛好被別的程式占用，最後兩行會變成（這是**警告不是錯誤**，可以繼續，或照 §5 換 port）：

```text
WARN port 3100 is already in use
Doctor completed with warnings — stop the process using the port before running the default demo
```

### 步驟 6：跑一次完整任務（demo）

```bash
npm run demo
```

這會用內建的 mock worker，走完一次「建立任務 → 執行 → 寫產出」。實測輸出：

```text
AIWFF Runtime listening on http://127.0.0.1:54330
Task ID: 10fe665b-ffc3-4099-9d27-8cfd552cb17d
Artifact: ...\data\artifacts\10fe665b-ffc3-4099-9d27-8cfd552cb17d.result.json
Status: done
✓ Demo completed — task lifecycle verified
```

**把這行的 `Task ID` 與 `Artifact` 路徑記下來**——那就是這次任務的成品位置。（demo 腳本會自動找一個空 port，所以上面顯示的 `54330` 只是範例，跟你 WebUI 用的 3100 是兩回事。）

### 步驟 7：驗證產出（verify-demo）

```bash
npm run verify-demo
```

這支會去檢查最新的 `.result.json` 是否存在、非空、`completed_at` 有值、任務狀態是 `done`。三行 `PASS` 就代表流程真的跑通了：

```text
PASS artifact exists and is non-empty: ...\data\artifacts\10fe665b-...result.json
PASS artifact completed_at present: 2026-07-05T13:47:39.516Z
PASS task status is done: 10fe665b-ffc3-4099-9d27-8cfd552cb17d
```

### 步驟 8：開瀏覽器控制台（WebUI）

```bash
npm run web        # 等同 npm start，兩個指令都會起同一個 WebUI
```

看到 `AIWFF Runtime listening on http://127.0.0.1:3100` 後，用瀏覽器打開這個網址，就會看到控制台首頁（HUD 分頁）：

![WebUI HUD 首頁](../images/webui-01-hud-dashboard.png)

> **換 port**：3100 被占用時，`npm run web` 不會自動換 port（會直接報 `EADDRINUSE`）。這時 Windows PowerShell 用 `$env:PORT=3200; npm run web`，bash / macOS / Linux 用 `PORT=3200 npm run web`，再開 `http://127.0.0.1:3200`。

裝到這裡，你已經有一個**完全免費、跑在自己電腦上**的 AI 任務助手骨架了。接下來怎麼用它建任務、看產出，見 [使用手冊 usage.md](usage.md)。想升級成真 AI，再看下面 §3。

> **關於 port 的一個誠實註記**：本節步驟 5 的「全綠」輸出，是在 port 3100 空著的乾淨機上驗到的預期樣子；我們自己的實測機因為 3100 已被其他服務占用，實際跑到的是上面那段 **WARN** 分支——兩條路徑都列在這裡，你落到哪條都有對照。

---

## §3 啟用真 Claude worker

先跑通 §2 的 mock 流程，再切真 Claude worker。真 worker 會呼叫你本機的 Claude CLI，所以這一步會使用你的 Claude 帳號與訂閱額度。

### 3.1 確認 Claude CLI 可用

在 repo 根目錄執行：

```bash
claude --version
```

如果系統找不到 `claude`，或 CLI 要求你先登入，請先依 Claude CLI 當下顯示的官方流程處理。這份手冊不替你建立帳號、購買方案，也不替你跳過 Claude CLI 的安全提示。

### 3.2 修改 `.env`

把 mock 關掉，並明確開啟 real worker：

```env
MOCK_WORKER=0
ENABLE_REAL_CLAUDE_WORKER=1
CLAUDE_CMD=claude
CLAUDE_BYPASS_APPROVALS=
```

`MOCK_WORKER=1` 會強制走 mock；要跑真 worker，請把它設成 `0` 或留空。`CLAUDE_BYPASS_APPROVALS` 預設留空，代表不加 `--dangerously-skip-permissions`。

### 3.3 啟動與驗證

重新啟動 runtime：

```bash
npm run web
```

用 WebUI 建一個小任務，確認任務完成後在 `data/artifacts/<task_id>.result.md` 看到 Markdown 產出。真 worker 產出的最後一行應符合 `CLAUDE.md` 契約，寫成 `DONE: ...`。

如果 Claude CLI 跳出核可提示，這是正常安全設計；逐次確認，或先回到 `MOCK_WORKER=1` 用免費 mock 模式驗流程。

---

## §4 啟用 Telegram

Telegram 是可選入口；不接 Telegram 時，WebUI 和 mock demo 仍可正常使用。這條路使用 polling，不需要 webhook、公開 hostname、反向代理或公開 IP。

### 4.1 建 bot 與取得 chat id

1. 在 Telegram 搜尋 `@BotFather`。
2. 傳 `/newbot`，照提示建立 bot，複製它給你的 token。
3. 搜尋 `@userinfobot`。
4. 傳任意訊息，複製你的數字 chat id。

### 4.2 填入 `.env`

```env
TG_BOT_TOKEN=<BotFather 給你的 token>
ADMIN_TG_CHAT_ID=<你的數字 chat id>
```

`ADMIN_TG_CHAT_ID` 是必要安全邊界：只有這個 chat id 的訊息會被接受。若 `TG_BOT_TOKEN` 有值但 `ADMIN_TG_CHAT_ID` 留空，runtime 會拒絕啟動 Telegram polling，WebUI 則照常可用。

### 4.3 啟動與測試

重新啟動 runtime：

```bash
npm run web
```

接著在 Telegram 對你的 bot 傳：

- `/start`：確認 bot 有回應。
- `/tasks`：查看最近任務。
- 任意文字：建立一筆任務；完成後 bot 會推送完成或失敗通知。

如果 bot 沒反應，先看終端機是否出現 `Refusing Telegram polling: ADMIN_TG_CHAT_ID is required when TG_BOT_TOKEN is set.`，再確認 `.env` 裡 token 與 chat id 都已填入。

---

## §5 疑難排解與支援管道

### 5.1 常見問題

| 症狀 | 可能原因 | 處理方式 |
|---|---|---|
| `node --version` 顯示低於 v18 或找不到命令 | 沒裝 Node 或版本太舊 | 先到 Node.js 官網裝 18 以上，再重跑安裝 |
| WebUI 起不來、說 port 被占用 | 預設 `3100` 已被別的程式使用 | 換一個 port：bash 用 `PORT=3200 npm run web`；**Windows PowerShell 要寫成** `$env:PORT=3200; npm run web` |
| PowerShell 設環境變數沒效果 | 用了 bash 的 `VAR=value 命令` 寫法 | Windows PowerShell 改用 `$env:VAR='value'; 命令`（bash / macOS / Linux 才用前綴寫法） |
| 跑完 demo 找不到產出 | 沒看 demo 輸出裡印的路徑，或終端機在錯的目錄 | 確認你在 repo 根目錄；mock 產出在 `data/artifacts/<task_id>.result.json` |
| Telegram 一直不啟動 | `TG_BOT_TOKEN` 有填但 `ADMIN_TG_CHAT_ID` 留空 | 補上你的數字 chat id 再重跑（見 §4） |
| 真 worker 一直跳核可提示 | 這是正常的安全設計 | 不要設 bypass 旗標去跳過；逐次核可，或先回 mock 模式驗流程 |

> 更多開發者向的排錯，見專案 [`INSTALL_AI.md`](../../INSTALL_AI.md) 第 6 節與 [`docs/architecture.md`](../architecture.md)。

### 5.2 支援管道

- **技術回報**：到 GitHub 開 Issue → <https://github.com/zaxardery8011-design/aiwff-runtime/issues>。如果目前無法建立 issue，請改從 <https://zax.com.tw> 聯絡。回報時附上作業系統、Node 版本、你跑的命令與完整錯誤訊息，能幫我們更快定位。
- **想要完整版 / 客製化**：<https://zax.com.tw>

---

*小主腦（`aiwff-runtime`）· MIT 授權*
