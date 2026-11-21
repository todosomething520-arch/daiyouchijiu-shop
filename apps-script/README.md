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
