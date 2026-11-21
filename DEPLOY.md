# 部署說明

本站是靜態頁面加上一個 Node 後端 `POST /api/order`。後端會在伺服器端驗證、重算金額，並用 LINE Messaging API 通知賣家。

**請勿把 LINE Channel Access Token 或賣家 userId 放到前端、Git 或壓縮檔。**

## 本機啟動

```bash
export LINE_CHANNEL_ACCESS_TOKEN="…"   # 或放到 secrets 目錄
export LINE_SELLER_USER_ID="…"
export PORT=8787
export HOST=127.0.0.1
node server.js
```

瀏覽 `http://127.0.0.1:8787/`。

## 永久公開網址（需要一個免費帳號）

這台開發機的網路會阻擋 Cloudflare Quick Tunnel、SSH 反向隧道與 ngrok 的連線協定，因此無法從這裡自動產生對外 HTTPS。請用以下任一免費方案（擇一註冊即可）：

### 方案 A：Render（建議，最接近目前的 Node 伺服器）

1. 到 https://render.com 註冊免費帳號。
2. 新建 Web Service，把這個資料夾的程式碼接上去（Git 或手動部署）。
3. 設定：
   - Build command：可留空
   - Start command：`node server.js`
   - Environment：
     - `HOST=0.0.0.0`
     - `LINE_CHANNEL_ACCESS_TOKEN`（Channel access token）
     - `LINE_SELLER_USER_ID`（賣家的 LINE userId）
4. 部署完成後會得到 `https://xxxx.onrender.com`。免費方案在閒置後會休眠，第一次開啟可能要等數秒。

### 方案 B：Fly.io 或 Railway

同樣用這個 `server.js`，設定相同的三個環境變數，並監聽平台提供的 `PORT`。

### 方案 C：Cloudflare Workers / Pages

需要 Cloudflare 免費帳號。適合長期穩定的 HTTPS。需要把 `server.js` 改寫成 Worker（或用 Pages Functions）並把 token 放在 Workers Secrets，不可寫進前端。

### 暫時公開（在你自己的電腦或 VPS）

若你在可正常連外的環境啟動本站，可再開一個暫時網址：

```bash
HOST=127.0.0.1 PORT=8787 node server.js
cloudflared tunnel --url http://127.0.0.1:8787
```

這會得到 `https://xxxx.trycloudflare.com`，關掉程式或重開後網址會變。
