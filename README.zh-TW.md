# 小主腦（專案名 aiwff-runtime）

> 英文完整規格 → [README.md](README.md)　·　安裝手冊 → [docs/zh-TW/install.md](docs/zh-TW/install.md)　·　使用手冊 → [docs/zh-TW/usage.md](docs/zh-TW/usage.md)

**裝在你自己電腦上的小型 AI 主腦——丟一件事給它，背景跑完，結果推回來，瀏覽器看進度。**

它不是又一個聊天視窗，而是一個跑在你本機的 agent runtime：你交代一件事，它會自己建任務、跑 worker、把過程與結果寫成檔案，做完通知你。所有狀態都留在你電腦的檔案裡，不上別人的伺服器。

## 為什麼是它

- 🖥️ **全在你本機**：任務、進度、產出都是你電腦上的普通檔案（`data/` 目錄），不是雲端 SaaS。
- 🆓 **開箱免費跑通**：預設 mock 模式，第一次安裝**不需要 API key、不需要付費帳號、不需要 Telegram**，就能看到一次完整的「建任務 → 執行 → 寫結果」。
- 🧠 **改文字檔就改個性**：大腦行為寫在 `CLAUDE.md`，記憶寫在 `memory/`，不用碰程式碼。
- 📱 **可選接 Telegram**：想用手機傳訊息丟任務、收結果就接，不想就只用瀏覽器。
- 📦 **零外部相依**：純 Node.js（18+），`npm install` 都是選填。

> **要花錢嗎？** 免費跑通 mock 模式不用錢。只有想接「真的呼叫 Claude」的 real worker 時，才需要付費的 Claude 訂閱——這件事在 [安裝手冊 §1](docs/zh-TW/install.md) 講得清清楚楚，不讓你裝到一半才發現。

## 最快上手：讓 AI 幫你裝

**① 準備**：裝好 Node.js 18+（`node --version` 驗證）與 git。

**② 取得程式**：

```bash
git clone https://github.com/zaxardery8011-design/aiwff-runtime
cd aiwff-runtime
```

**③ 對你的 AI coding agent 說一句**：

> 「照 INSTALL_AI.md 幫我裝好」

檢查環境、安裝、驗證、啟動 WebUI，全部由 AI 依 [`INSTALL_AI.md`](INSTALL_AI.md) 自駕完成。跑完你會拿到一個可開的本機網址（預設 `http://127.0.0.1:3100`）。

不想用 AI 裝？手動五命令版與逐步說明見 [安裝手冊](docs/zh-TW/install.md)。

## 接下來

| 我想… | 看這裡 |
|---|---|
| 一步步把它裝起來、跑通 | [安裝手冊 docs/zh-TW/install.md](docs/zh-TW/install.md) |
| 學會怎麼用、產出在哪、怎麼調個性 | [使用手冊 docs/zh-TW/usage.md](docs/zh-TW/usage.md) |
| 看完整技術規格、架構、`.env` 欄位 | [英文 README.md](README.md) |

## 支援

- **技術支援（唯一管道）**：GitHub Issues → <https://github.com/zaxardery8011-design/aiwff-runtime/issues>
- **想要完整版 / 客製化**：<https://zax.com.tw>

---

*小主腦（`aiwff-runtime`）· MIT 授權*
