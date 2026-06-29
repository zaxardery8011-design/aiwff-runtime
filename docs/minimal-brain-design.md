# aiwff-runtime minimal-brain — 開源最小主腦設計稿 v0.1

> **目的**：讓開發者（或 AI）讀完能精準描述「這個開源項目是什麼、每個元件怎麼連、大腦在哪裡、要設定什麼」，然後能動手建它。

---

## 1. 一句話定位

**aiwff-runtime minimal-brain = 「發一句話給 Telegram → Claude 自主執行任務 → 結果推回你 → 瀏覽器看進度」的本地 AI 主腦入門套件。**

不是：
- ✗ 聊天機器人（你說一句，它回一句，結束）
- ✗ API wrapper（背後其實是 ChatGPT，UI 換了殼）
- ✗ 工作流程工具（你畫好流程圖，它按圖索驥）
- ✗ SaaS 月費服務（你的資料跑在別人伺服器）

是：
- ✓ 本地跑的 AI agent，Claude 在你電腦上自主執行（讀檔、寫檔、跑程式）
- ✓ TG Bot 是輸入/輸出介面，不是功能主體
- ✓ 任務狀態存在本機檔案，不依賴雲端
- ✓ 一個 CLAUDE.md 定義它是誰、能做什麼，你改它就改了「大腦」

---

## 2. 在 AI 應用譜系的座標

```
L1  純問答      ChatGPT.com / Claude.ai — 聊天就結束
L2  API 套殼   用 API 加個 UI，無持久狀態
L3  IDE 整合   Claude Code / Codex CLI — 有 tool use，但每 session 重來
L4  零碼工作流  n8n / Make / Zapier — 流程固定，不自主判斷
────────────────────────────────────────────
L5  本地 Agent  ← aiwff-runtime minimal-brain 在這層
                「接收任意指令 → 自主規劃 → 用工具執行 → 持久任務狀態」
L6  多節點編排  ← 完整版 AIWFF 在這層（A機主腦 + 寂寞伯 + AG + Codex）
```

minimal-brain 佔 **L5 底座**——不到完整版 AIWFF 的 L6 規模，但已超過 L1–L4 的能力邊界。目標是讓任何人能在 1 小時內把 L5 跑起來。

---

## 3. 白話架構（8 個元件）

### 元件 A：Daemon（中控）

**白話**：你電腦上永遠在跑的一個背景程式，它不做任務，它管任務。

| 項目 | 說明 |
|---|---|
| 是什麼 | Node.js 單檔，port 3100，HTTP server |
| 負責 | 接收任務 / 管 queue / 叫 Claude / 回報結果 |
| 不負責 | 思考 / 判斷 / 執行（那是 Claude 的事） |
| 零依賴 | 不需要 npm install，Node.js 內建模組完成 |

啟動後永遠活著，直到你手動停止。

---

### 元件 B：TG Bot（輸入＋輸出介面）

**白話**：你的 Telegram 就是操作介面。打一句話傳過去，就等 Claude 做完。

| 動作方向 | 內容 |
|---|---|
| 你 → TG Bot | 任何一句任務描述 |
| Daemon 收到 | 把它包成一個 task，存到 `data/tasks/` |
| Claude 做完 | Daemon 把結果文字（或檔案路徑）推回你的 TG |

技術：Bot polling（每 2 秒問 Telegram API），不需要 webhook / 公網 IP。

---

### 元件 C：大腦（Claude CLI）

**白話**：這是整套系統最核心的部分。不是「工具」，是「自主行動的代理人」。

> 一般 Claude.ai = 你說一句，它回一句，然後結束。
>
> 這裡的 Claude = 收到任務後，**主動使用工具**（讀檔、寫檔、跑指令），自己一步步把事情做完，完成後寫出結果。

**為什麼這是「大腦」不是「工具」？**

差別在一個檔案：**`CLAUDE.md`**（放在工作目錄）。

Claude CLI 啟動時會讀這個檔，知道：
1. 它是誰（身份、語氣、風格）
2. 什麼能做、什麼不能做（邊界）
3. 完成任務的標準是什麼（驗收）
4. 結果要寫到哪裡、用什麼格式（輸出規格）

**沒有 CLAUDE.md = Claude 收到任務只會「回答問題」**
**有 CLAUDE.md = Claude 收到任務會「主動執行到完成」**

執行指令（Daemon 呼叫 Claude 的方式）：
```bash
claude --dangerously-bypass-approvals-and-sandbox \
       -p "任務：<task_title>\n指令：<task_instruction>"
```

Claude 執行時能用的工具（tool use）：
- `Read` — 讀你電腦上的任何檔案
- `Write` — 寫出新檔案
- `Edit` — 修改現有檔案
- `Bash` — 跑 shell 指令
- `Glob / Grep` — 找檔案 / 搜字串

---

### 元件 D：File-bus（任務存儲）

**白話**：一個 `data/` 資料夾，任務的整個生命週期都存在這裡，不用資料庫。

```
data/
  tasks/
    t001.json               ← 任務詳情（id / 標題 / 指令 / 狀態）
    t001.progress.jsonl     ← Claude 每一步在做什麼（即時串流）
  artifacts/
    t001.result.md          ← Claude 完成後的結果
```

好處：任何時候你都能直接打開資料夾看發生了什麼。沒有黑箱。

---

### 元件 E：WebUI Cockpit（儀表板）

**白話**：瀏覽器打開 `http://127.0.0.1:3100`，看所有任務的狀態。也可以從這裡手動新增任務。

| 區塊 | 內容 |
|---|---|
| 任務列表 | 所有任務、狀態（pending / doing / done / failed）、建立時間 |
| 即時進度 | 點開任務，看 Claude 正在做什麼（progress.jsonl 串流） |
| 建新任務 | 填標題 + 指令，送出 → 等 Claude 做 |

純 HTML/CSS/JS，不需要前端框架。

---

### 元件 F：記憶（Memory）

**白話**：Claude 記得你上次說的事、你的習慣、以前做過什麼任務。

```
memory/
  facts.md          ← 重要事實（自動追加）
  preferences.md    ← 你的偏好（「我喜歡簡短回答」→ 存這）
  task_log.md       ← 歷史任務一行摘要
```

每次新任務，Daemon 把這幾個檔注入 Claude 的 system prompt。不需要 RAG，直接文字注入。

---

### 元件 G：任務治理（Inbox / Watching）

**白話**：Inbox 是「還沒處理的事情」的收件匣；Watching 是「你叫我記得提醒你的事」。

```
data/
  inbox/           ← 待消化事件（任務完工 / 外部通知 / 錯誤告警）
  watching/        ← 跨 session 追蹤（如：「明天提醒我查 XX」）
```

Claude 每次啟動時掃一眼 inbox + watching，有未處理的就先告訴你。

---

### 元件 H：自我審查（Self-verify）

**白話**：任務做完，Claude 自己回頭確認「我真的做完了嗎？」不只信第一遍。

流程：
1. 任務結束 → 自動再問 Claude 一次：「剛才做了什麼？artifact 在哪？有明顯漏洞嗎？」
2. Claude 回 PASS → 確認 done
3. Claude 回 FAIL → status 改 failed，TG 通知你處理

---

## 4. 資料流（完整一輪）

```
[你] 傳 Telegram 訊息：「幫我把桌面所有 PDF 整理成清單」
         │
         ▼
[TG Bot] polling 收到訊息
         │
         ▼
[Daemon] 建立 task t001
  → data/tasks/t001.json: { status: "pending", instruction: "幫我把..." }
         │
         ▼
[Daemon] spawn Claude CLI
  → claude --dangerously-bypass-approvals-and-sandbox \
           -p "任務：整理 PDF\n指令：幫我把桌面所有 PDF..."
         │
         ▼
[Claude] 讀 CLAUDE.md，知道自己是誰、能用什麼工具
         │
         ▼
[Claude] 自主執行：
  1. Glob("C:/Users/User/Desktop/**/*.pdf")  → 找到 12 個 PDF
  2. 整理成 Markdown 表格
  3. Write("data/artifacts/t001.result.md", "<表格內容>")
  4. 每步寫 data/tasks/t001.progress.jsonl
         │
         ▼
[Daemon] 偵測到 artifact 出現 → status 改 "done"
         │
         ▼
[Daemon] 讀 artifact → 推回 TG：「任務完成，找到 12 個 PDF：\n1. report.pdf...」
         │
         ▼
[你] TG 收到結果 ✓
[WebUI] 任務列表同步顯示 done ✓
```

---

## 5. CLAUDE.md 最精簡版（大腦的靈魂）

> 這個檔案是「大腦配置」。你改它，就改了 Claude 的行為。
> 不需要改 code，只需要改 CLAUDE.md。

```markdown
# Agent 配置

你是用戶的本地 AI 助理。收到任務後不要只是回答——要**動手執行到完成**。

## 執行規則
1. 讀懂任務意圖（不是只照字面做）
2. 用工具完成（Read / Write / Edit / Bash / Glob / Grep）
3. 結果存到 `data/artifacts/<task_id>.result.md`
4. 最後一行寫：`DONE: <一句話說你做了什麼>`

## 邊界
- 不修改 .env 或任何 credentials 檔案
- 不發外部網路請求（除非任務明確說要）
- 不知道怎麼做就在 progress 裡說明，不要假裝完成

## 工作目錄
{project_root}
```

---

## 6. 環境設定（.env）

```env
# 必填
TG_BOT_TOKEN=你的 Telegram Bot Token（從 @BotFather 取得）

# 選填（有預設值）
PORT=3100
CLAUDE_CMD=claude
WORK_DIR=./workspace
```

**取得 TG_BOT_TOKEN 步驟（3 分鐘）：**
1. 在 Telegram 搜尋 `@BotFather`
2. 傳 `/newbot`
3. 給 bot 取名字
4. 複製給你的 token 貼到 `.env`

**需要 Claude Max Plan（必須）：**
`--dangerously-bypass-approvals-and-sandbox` 模式需要 Claude 訂閱帳號，免費帳號無法使用。

---

## 7. 一鍵啟動流程

```bash
git clone https://github.com/<org>/aiwff-runtime
cd aiwff-runtime
cp .env.example .env
# 填入 TG_BOT_TOKEN
npm start
# → http://127.0.0.1:3100
# → 你的 TG Bot 已上線
```

驗收指令：
```bash
npm run doctor    # 環境檢查（Node 版本 / claude CLI / .env）
npm run demo      # 跑一個 mock 任務
npm run verify-demo   # 確認 demo 結果正確
```

---

## 8. 跟完整版 AIWFF 的差異

**原則：只拿掉多節點。其他功能全部保留，以簡化版形式實作。**

| 功能 | AIWFF 完整版（複雜） | minimal-brain（簡化版，保留） |
|---|---|---|
| 大腦配置 | SOUL.md + SOUL_GOVERNANCE.md + CLAUDE.md（完整治理） | CLAUDE.md（身份 + 邊界 + 規則，你直接改） |
| 跨 session 記憶 | structured memory + frontmatter typed + auto-sediment + 去重 | 輕量 markdown 記憶，任務完成後自動抽取摘要存 `memory/` |
| 任務治理 | inbox / watching / patrol / backlog SSOT | 簡化 inbox（JSON 事件佇列）+ watching（待辦清單） |
| 多節點 fleet | A機主腦 + B機寂寞伯 + 跨機派工 | **✗ 唯一拿掉的功能**（單機） |
| 外部諮詢 | AG（Gemini）+ Codex CLI | 選配：.env 填 GEMINI_API_KEY 即啟用 |
| 自我審查 | multi-juror verify（3+ agent 投票） | 簡化 verify：任務完成後自動派一次 Claude 回審 |
| 介面 | TG + LINE Bot + WebUI | TG + WebUI（LINE 可後期加） |
| 設定難度 | 高（需理解治理架構） | 低（.env 幾行，CLAUDE.md 改大腦行為） |

### 各功能「簡化版」長什麼樣

**記憶（輕量版）**
```
memory/
  facts.md          ← 重要事實（Claude 每次任務後自動追加）
  preferences.md    ← 用戶偏好（第一次提到就存）
  task_log.md       ← 任務摘要清單（id / 標題 / 結果一行）
```
新任務開始時，Daemon 把 `memory/facts.md` + `memory/preferences.md` 注入 system prompt，Claude 就「記得」了。

**任務治理（簡化版）**
```
data/
  inbox/           ← 待消化事件（新任務 / worker 完工 / 外部通知）
  watching/        ← 跨 session 追蹤清單（用戶說「記得提醒我」）
```
不做 patrol / backlog SSOT / 複雜排程——那是 AIWFF 的進階層。

**自我審查（簡化版）**
- 任務完成後，自動再跑一次 Claude：`"剛才這個任務做完了嗎？artifact 存在嗎？有沒有明顯錯誤？"`
- 回答 PASS → status 確認 done
- 回答 FAIL → status 改 failed，TG 通知用戶

---

## 9. 誠實限制

| 限制 | 說明 |
|---|---|
| 需要 Claude Max Plan | claude CLI `--dangerously-bypass-approvals-and-sandbox` 要訂閱 Claude Max，免費帳號不支援 |
| 單用戶設計 | 一個 TG Bot 只綁一個管理員 ID，不適合多人共用 |
| 無多節點 | 只跑在單台機器，不支援 A機+B機 fleet 派工 |
| Windows PATH 設定 | Claude CLI 在 Windows 需要確認 PATH 包含 claude.cmd |
| 記憶是文字注入非 RAG | 記憶量大時 context 會撐大；建議定期整理 `memory/facts.md` |
| 不適合長跑任務 | 超過 10 分鐘的任務沒有斷點續傳機制（AIWFF 完整版才有） |

---

## 10. 路線圖（Phase 1 → 2 → 3）

| Phase | 狀態 | 內容 |
|---|---|---|
| Phase 1 mock-first | ✅ 完成 | 任務生命週期跑通（mock worker，3 秒完成）、WebUI 可用 |
| Phase 2 Claude worker | 🔵 本設計稿 | 接上真實 Claude CLI，TG Bot 串通，CLAUDE.md 大腦配置 |
| Phase 3 記憶層（選配） | ⬜ 待規劃 | 加輕量記憶（任務歷史 context injection），讓 Claude 記得過去任務 |

---

> *minimal-brain 的價值：10 分鐘內讓你體驗「對著 TG 說一句話，Claude 在本機自主把事做完」。*
> *它是 AIWFF 的精簡版入口，不是終點。*
