# 訂單 Google Sheet（Apps Script webhook）

此腳本把訂單寫入試算表 `Orders` 分頁，並依「手機號碼」判斷是否首購、折抵券是否可用。部署完成前，伺服器沒有設定環境變數，行為與現在相同。

擁有者請用 **todosomething520@gmail.com** 操作。

## 建立試算表並貼上腳本

1. 用上述 Google 帳號登入，到 [Google 試算表](https://sheets.google.com) 新建一份試算表（建議名稱：`大又持久錠訂單`）。
2. 功能表選擇 **Extensions（擴充功能）> Apps Script**。
3. 刪除編輯器裡預設的 `function myFunction() { ... }`，改貼上同資料夾的 `Code.gs` 全部內容，儲存。
4. 左側齒輪 **Project Settings（專案設定）> Script properties（指令碼屬性）> Add script property**：
   - Property：`SHARED_SECRET`
   - Value：一組長隨機字串（請自行產生，不要寫進 Git）。之後 Render 的 `SHEET_SECRET` 必須完全相同。
5. 右上角 **Deploy（部署）> New deployment（新增部署）**。
   - Type（類型）選 **Web app（網頁應用程式）**。
   - Execute as（執行身分）：**Me（我）**。
   - Who has access（存取權限）：**Anyone（任何人）**。
6. 按 Deploy。Google 會要求授權：請選 todosomething520@gmail.com，允許此指令碼讀寫「這份試算表」（必要時勾選顯示全部權限後允許）。
7. 部署完成後複製 **Web app URL**（形如 `https://script.google.com/macros/s/…/exec`）。

`Orders` 分頁與表頭列會在第一筆訂單寫入時自動建立，不必手動先建表頭。

## 之後要填到 Render 的環境變數

（先完成上面部署，再填；現在不要填也沒關係，缺變數時訂單流程不會壞。）

- `SHEET_WEBHOOK_URL`：上一步的 Web app URL
- `SHEET_SECRET`：與 Script Property `SHARED_SECRET` 相同的值

兩個都要設齊，伺服器才會呼叫試算表。請用 Render Dashboard 或環境變數工具設定，**不要寫進程式或 Git**。

## 更新腳本

改過程式後：Deploy > Manage deployments > 鉛筆編輯 > Version 選 New version > Deploy。URL 通常不變。

## 權限與安全

- 「Anyone」表示知道 URL 的人都能 POST，因此 `SHARED_SECRET` 必須夠長、不可外流。
- 指令碼以你的帳號執行，只應綁在這一份訂單試算表。
- 若授權被拒或部署失敗，伺服器會自動退回「請客服人工核對」的 LINE 文案，訂單仍會成立。

## 手機號碼格式

試算表會把 `09xxxxxxxx` 當成數字而丟掉開頭的 0。更新後的 `Code.gs` 會把 D 欄設成純文字，讀取時若少了開頭 0 也會補上。若你已部署過舊版，請把新的 `Code.gs` 貼上後 **Deploy > Manage deployments > 新版本**，否則「是否首購」與折抵券核對會失準。

## v3：推薦碼（2026-11-22）

新版 `Code.gs` 新增兩個 action，舊的 `checkAndRecord` 仍保留、行為不變：

- `checkAndRecordV3`：記錄訂單，同時處理推薦碼綁定、9 折與推薦人回饋金。
- `lookupReferral`：結帳頁預估用，只查詢、不寫入。

### 規則

- 每支手機下單後都會在 **`Members`** 分頁拿到一組 6 碼推薦碼（英文字母加數字，不含 0、O、1、I），終身不變。
- 尚未綁定的手機輸入有效推薦碼（不能是自己的，也不能和對方互綁）→ 永久綁定，之後輸入別的推薦碼會被忽略。
- 已綁定手機的**每一筆**訂單（首購或回購，不必再輸入推薦碼）商品小計打 9 折，四捨五入到元。
- 9 折與 NT$250 首購折抵券二擇一：使用折抵券的那一筆不打 9 折。
- 推薦人回饋金 = 客人實付商品金額（扣掉 9 折或折抵券，不含運費）× 10%，四捨五入到元，累加到推薦人的 `Members`「累積回饋金」。
- 免運仍以折扣前的商品小計判斷（滿 NT$3,000）。
- 回饋金只記帳，不會自動折抵。客人找 LINE 客服折抵時，請手動在 `Members`「已折抵回饋金」填入累計已用金額，「回饋金餘額」會自動計算。

### Members 分頁欄位

手機｜推薦碼｜綁定推薦碼｜綁定推薦人手機｜建立時間｜綁定時間｜累積回饋金｜已折抵回饋金｜回饋金餘額（公式）｜首筆訂單

`Orders` 分頁會自動在第 18～23 欄補上：輸入推薦碼｜推薦狀態｜綁定推薦碼｜推薦9折｜推薦人回饋金｜客人推薦碼。

### 部署（網址不變）

1. 開啟訂單試算表 > **擴充功能 > Apps Script**，把 `Code.gs` 全部內容換成這個資料夾的新版本，儲存。
2. **Deploy（部署）> Manage deployments（管理部署作業）** > 選現有的 Web app 部署 > 鉛筆（編輯）> Version 選 **New version（新版本）** > Deploy。
   - 不要按「New deployment（新增部署作業）」，那會產生新網址。
3. 若 Google 要求重新授權，請用 todosomething520@gmail.com 允許。

（選用）在編輯器上方函式選單選 `backfillMembers` 按「執行」，可以替以前已下單的客人一次補發推薦碼；不執行也沒關係，舊客下次下單時會自動產生。

### 尚未更新腳本時

伺服器會先呼叫 `checkAndRecordV3`。舊版腳本回 `unknown_action`（不會寫入），伺服器就改用 `checkAndRecord` 記錄訂單；推薦碼一律**不自動給 9 折**，LINE 通知標示「推薦碼 XXX 待人工確認」，客人畫面提示 9 折由客服確認後調整。試算表連不上時也是同樣處理。

### 本機測試

```bash
git show <舊版commit>:apps-script/Code.gs > /tmp/Code.v2.gs   # 選用：一併測試舊版相容
node test/referral.test.js /tmp/Code.v2.gs
```

測試在 Node 裡模擬 Apps Script 執行真正的 `Code.gs`，並攔截 LINE 推播，不會送出任何訊息、也不會碰到真的試算表。
