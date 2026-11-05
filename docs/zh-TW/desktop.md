# 小主腦接 Claude 桌面端

> 接好之後，你在 Claude 桌面端可以直接叫同一顆小主腦：看它活著沒、丟工作給它背景跑、讀結果、讀記憶。
>
> 還沒裝小主腦，先看[安裝手冊](install.md)。

## 怎麼接

選一種：

- **安裝時**：偵測到 Claude 桌面端時，安裝流程會問「要接上 Claude 桌面端嗎？」，按 Enter＝接。
- **裝好之後**：雙擊安裝資料夾的 `connect-desktop.cmd`（開發環境也可以跑 `npm run connect:desktop`）。
- **不想被問**：安裝時帶 `-ConnectDesktop` 或 `-NoDesktop`。帶 `-Unattended` 卻沒帶 `-ConnectDesktop` 就不接：這是動別的 App 的設定。

接好後要**從系統匣完全結束 Claude 再開**才會生效，關視窗不算。小主腦不會幫你關 App。

這一筆設定同時給 Chat 分頁和 Code 分頁（local session）用，不用接兩次。

一台電腦一次只接一個小主腦。設定裡已經接著別的安裝資料夾時，接線程式會停下來講現在接的是哪個，不會蓋掉。要換：先雙擊那邊的 `uninstall.cmd`，再跑一次這邊的 `connect-desktop.cmd`；或安裝時帶 `-ReplaceDesktop`。那個資料夾已經刪掉的話會直接換。

## 接好能做什麼

| 工具 | 做什麼 | 花額度嗎 |
|---|---|---|
| `aiwff_status` | 小主腦活著沒、接的是什麼大腦、幾件任務在跑 | 不花 |
| `aiwff_new_task` | 把工作交給小主腦背景跑 | **會**：大腦是 Claude 時用掉你的訂閱額度 |
| `aiwff_tasks` | 最近的任務 | 不花 |
| `aiwff_task_result` | 讀某件任務的結果 | 不花 |
| `aiwff_memory` | 列出或讀 `memory/*.md`，唯讀 | 不花 |

試試看，在 Claude 桌面端問：「小主腦現在是什麼狀態？」

**大腦是 Claude 時**：`aiwff_new_task` 交出去的任務跑完，用 `aiwff_task_result` 讀結果。任務只能改自己的工作資料夾，不能跑命令、程式或腳本，也不能上網。做不到的工作會停在「等你回答」，問能不能開放權限，這種問題回答也解不開，一樣會用掉額度。

舊安裝要先開放寫檔，不然任務連結果檔都寫不了：雙擊 `connect-brain.cmd` 選 Claude，再雙擊 `restart-runtime.cmd`。聊天不受影響；大腦是 Ollama 時只回文字，不會動檔案。

`.env` 設 `AIWFF_MODE=chat` 時，`aiwff_new_task` 會拒絕，跟 WebUI 一樣。`aiwff_new_task` 不經過 WebUI 的確認卡，所以 Claude 桌面端問你要不要允許這個工具時，不要選「一律允許」。

小主腦沒開時，工具會回白話錯誤和怎麼開，不會讓整條連線掛掉。

## 動到了什麼

- 只動 Claude 桌面端設定的 `mcpServers.aiwff` 這一個鍵，其他鍵一律保留。移除時只拿掉指向這個安裝資料夾的那一筆。
- 寫之前先備份成 `claude_desktop_config.json.aiwff-bak-<時間>`，放在同一個資料夾。備份不會自動清，也留著當時其他 server 的設定（可能有金鑰），不需要了請自己刪。
- 設定檔壞掉時會中止，一個字都不寫。
- token 不進設定檔，也不會回給模型：server 自己讀 `.env`。

設定檔在哪：從微軟封裝版安裝的 Claude，真檔在 `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`；一般 PowerShell 看不到文件寫的 `%APPDATA%\Claude\`。接線程式會先找前者再找後者，並把選到的路徑印出來。

## 移除

二選一：

- 只拿掉接線：在 PowerShell 跑 `& "<安裝資料夾>\connect-desktop.cmd" --remove`。
- 整個移除小主腦：雙擊安裝資料夾的 `uninstall.cmd`，接線會一起拿掉。

一樣要從系統匣完全結束 Claude 再開，才算完全斷開。

## 終端機的 Claude Code

獨立的 `claude` 指令不讀桌面端設定。要在終端機也叫得到，自己加一行：

```powershell
claude mcp add --scope user aiwff -- "<node 絕對路徑>" "<安裝資料夾>\suite\aiwff-runtime\agent\mcp-server.js"
```

移除：`claude mcp remove --scope user aiwff`。

## 接不上時

| 你看到的 | 原因 | 處理 |
|---|---|---|
| 重開後還是沒有 aiwff | 只關了視窗；或 App 開著時把設定蓋回去了 | 從系統匣完全結束 Claude，再跑一次 `connect-desktop.cmd`，然後開 App |
| 「沒有找到 Claude 桌面端設定」 | 還沒開過 Claude 桌面端 | 先開一次，再跑一次 |
| 「設定檔不是合法 JSON」 | 設定檔壞了，接線程式沒動它 | 修好設定檔再跑一次 |
| 「aiwff 已經接著別的小主腦」 | 這台電腦接著另一個安裝資料夾 | 照上面「怎麼接」換 |
| 工具回「小主腦沒開」 | runtime 沒在跑 | 照工具訊息的方法打開，或雙擊安裝資料夾的 `start-runtime.cmd` |
| 搬過資料夾或換過 node 後連不上 | 設定裡是絕對路徑 | 再跑一次 `connect-desktop.cmd` |
