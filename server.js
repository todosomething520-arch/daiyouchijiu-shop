/**
 * 大又持久錠 — 靜態頁 + POST /api/order
 * 以 Node 內建模組運作，不把 LINE token 寫進前端。
 *
 * 啟動：
 *   環境變數（部署時務必用 Render env，不要寫進 Git）：
 *     LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID（或 LINE_SELLER_USER_ID）
 *     HOST=0.0.0.0  PORT 由平台注入
 *   本機未設環境變數時，可從 SECRETS_DIR 讀取。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.resolve(__dirname);
const SECRETS_DIR = process.env.SECRETS_DIR || "/workspace/onepage-shop-secrets";
const DATA_DIR = process.env.DATA_DIR || require("os").tmpdir() + "/onepage-shop-data";
const LINE_API = "https://api.line.me/v2/bot/message/push";

const SHIPPING_FEE = 60;
const FREE_SHIPPING_AT = 3000;
const PRODUCT = "大又持久錠";

const PLANS = Object.freeze({
  p1: { id: "p1", name: "1錠體驗", tablets: 1, price: 250 },
  p3: { id: "p3", name: "3錠組", tablets: 3, price: 700 },
  p5: { id: "p5", name: "5錠組", tablets: 5, price: 1100 },
  pbulk: { id: "pbulk", name: "批量優惠", lineName: "批量", bulk: true, unitPrice: 200, qtyMin: 10, qtyMax: 100 },
});

const PLAN_ORDER = Object.freeze(["p1", "p3", "p5", "pbulk"]);

const LIMITS = {
  name: [2, 40],
  lineId: [0, 40],
  store: [2, 80],
  notes: [0, 200],
  qty: [1, 20],
  maxLines: 5,
};

function qtyBounds(plan) {
  if (plan && plan.bulk) return [plan.qtyMin, plan.qtyMax];
  return LIMITS.qty;
}

function formatItemLine(it) {
  if (it.bulk) return `・批量 × ${it.tabletTotal} 錠　${money(it.subtotal)}`;
  return `・${it.planName} × ${it.quantity} 組（共 ${it.tabletTotal} 錠）　${money(it.subtotal)}`;
}

function buildLine(plan, quantity) {
  if (plan.bulk) {
    return {
      planId: plan.id,
      planName: plan.lineName,
      bulk: true,
      tabletsEach: 1,
      quantity,
      tabletTotal: quantity,
      unitPrice: plan.unitPrice,
      subtotal: plan.unitPrice * quantity,
    };
  }
  return {
    planId: plan.id,
    planName: plan.name,
    bulk: false,
    tabletsEach: plan.tablets,
    quantity,
    tabletTotal: plan.tablets * quantity,
    unitPrice: plan.price,
    subtotal: plan.price * quantity,
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const PUBLIC_FILES = new Set(["index.html", "app.js", "styles.css"]);
const PUBLIC_DIRS = new Set(["images"]);

function readSecret(envName, fileName) {
  if (process.env[envName] && process.env[envName].trim()) {
    return process.env[envName].trim();
  }
  const p = path.join(SECRETS_DIR, fileName);
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch (err) {
    return "";
  }
}

const LINE_TOKEN = readSecret("LINE_CHANNEL_ACCESS_TOKEN", "line_token");
const LINE_USER_ID =
  (process.env.LINE_USER_ID && process.env.LINE_USER_ID.trim()) ||
  readSecret("LINE_SELLER_USER_ID", "line_user_id");

if (!LINE_TOKEN || !LINE_USER_ID) {
  console.error("Missing LINE credentials (env or secrets dir). Refusing to start.");
  process.exit(1);
}

try {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
} catch (err) {
  console.error("Cannot create data dir; orders will not be written to disk");
}

function money(n) {
  return "NT$" + Math.round(n).toLocaleString("zh-TW");
}

function normalizePhone(raw) {
  return String(raw || "").replace(/[\s-]/g, "");
}

function clampText(s) {
  return String(s || "").trim();
}

function generateOrderNo() {
  const local = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" });
  const stamp = local.slice(2, 10).replace(/-/g, "");
  const rand = crypto.randomInt(100, 1000);
  return "DY" + stamp + "-" + rand;
}

function formatOrderText(order) {
  const c = order.customer;
  const lines = (order.items || []).map(formatItemLine);
  return [
    `訂單編號：${order.orderNo}`,
    `商品：${order.product}`,
    "明細：",
    ...lines,
    `商品小計：${money(order.subtotal)}（共 ${order.tabletTotal} 錠）`,
    `運費：${order.shippingFee ? money(order.shippingFee) : "免運"}`,
    `應付：${money(order.total)}`,
    `姓名：${c.name}`,
    `手機：${c.phone}`,
    `LINE ID：${c.lineId || "（未填）"}`,
    `7-11門市：${c.store}`,
    `備註：${c.notes || "（無）"}`,
  ].join("\n");
}

function parseItems(body) {
  let raw = body.items;
  if (!Array.isArray(raw)) {
    if (body.planId) {
      raw = [{ plan: body.planId, qty: body.quantity }];
    } else {
      return { error: "invalid_items" };
    }
  }
  if (raw.length < 1 || raw.length > LIMITS.maxLines) {
    return { error: "invalid_items" };
  }

  const merged = new Map();
  for (const row of raw) {
    if (!row || typeof row !== "object") return { error: "invalid_items" };
    const planId = String(row.plan || row.planId || "").trim();
    const plan = PLANS[planId];
    if (!plan) return { error: "invalid_plan" };
    const qty = Number(row.qty != null ? row.qty : row.quantity);
    const [qMin, qMax] = qtyBounds(plan);
    if (!Number.isInteger(qty) || qty < qMin || qty > qMax) {
      return { error: "invalid_quantity" };
    }
    const prev = merged.get(planId) || 0;
    const next = prev + qty;
    if (next > qMax) return { error: "invalid_quantity" };
    if (plan.bulk && next < qMin) return { error: "invalid_quantity" };
    merged.set(planId, next);
  }

  if (merged.size < 1 || merged.size > LIMITS.maxLines) {
    return { error: "invalid_items" };
  }

  const items = PLAN_ORDER.filter((id) => merged.has(id)).map((id) => buildLine(PLANS[id], merged.get(id)));
  return { items };
}

function validateAndBuild(body) {
  if (!body || typeof body !== "object") {
    return { error: "invalid_body" };
  }
  // Honeypot: bots often fill hidden fields
  if (clampText(body.website) || clampText(body.company) || clampText(body.url)) {
    return { error: "rejected" };
  }

  const parsed = parseItems(body);
  if (parsed.error) return parsed;
  const items = parsed.items;

  const name = clampText(body.name);
  const phone = normalizePhone(body.phone);
  const lineId = clampText(body.lineId);
  const store = clampText(body.store);
  const notes = clampText(body.notes);

  if (name.length < LIMITS.name[0] || name.length > LIMITS.name[1]) return { error: "invalid_name" };
  if (!/^09\d{8}$/.test(phone)) return { error: "invalid_phone" };
  if (lineId.length > LIMITS.lineId[1]) return { error: "invalid_lineId" };
  if (store.length < LIMITS.store[0] || store.length > LIMITS.store[1]) return { error: "invalid_store" };
  if (notes.length > LIMITS.notes[1]) return { error: "invalid_notes" };

  const subtotal = items.reduce((s, it) => s + it.subtotal, 0);
  const tabletTotal = items.reduce((s, it) => s + it.tabletTotal, 0);
  const shippingFee = subtotal >= FREE_SHIPPING_AT ? 0 : SHIPPING_FEE;
  const total = subtotal + shippingFee;
  const orderNo = generateOrderNo();

  const order = {
    orderNo,
    createdAt: new Date().toISOString(),
    product: PRODUCT,
    items,
    tabletTotal,
    subtotal,
    shippingFee,
    shippingMethod: "7-11 賣貨便",
    total,
    customer: { name, phone, lineId, store, notes },
  };
  return { order };
}

/* ===== rate limit (in-memory) ===== */
const hits = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 8;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_MAX = 40;
const globalHits = [];

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket.remoteAddress || "unknown";
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  while (globalHits.length && now - globalHits[0] > GLOBAL_WINDOW_MS) globalHits.shift();
  globalHits.push(now);
  return arr.length > RATE_MAX || globalHits.length > GLOBAL_MAX;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function appendOrderLog(record) {
  const file = path.join(DATA_DIR, "orders.jsonl");
  fs.appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 }, (err) => {
    if (err) console.error("order log write failed");
  });
}

async function pushLine(text) {
  const res = await fetch(LINE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + LINE_TOKEN,
    },
    body: JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: "text", text }],
    }),
  });
  // Do not log response body if it might include request echoes; status only.
  const status = res.status;
  let errMsg = "";
  if (!res.ok) {
    try {
      const data = await res.json();
      errMsg = data && data.message ? String(data.message).slice(0, 80) : "";
    } catch (_) {
      errMsg = "";
    }
  }
  return { status, ok: res.ok, errMsg };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("too_large"), { code: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error("invalid_json"), { code: "invalid_json" }));
      }
    });
    req.on("error", reject);
  });
}

async function handleOrder(req, res) {
  if (rateLimited(clientIp(req))) {
    return json(res, 429, { ok: false, error: "rate_limited" });
  }
  let body;
  try {
    body = await readBody(req, 8 * 1024);
  } catch (err) {
    const code = err.code === "too_large" ? 413 : 400;
    return json(res, code, { ok: false, error: err.code || "invalid_body" });
  }

  const result = validateAndBuild(body);
  if (result.error) {
    return json(res, 400, { ok: false, error: result.error });
  }

  const order = result.order;
  const text = formatOrderText(order);
  let push;
  try {
    push = await pushLine(text);
  } catch (err) {
    console.error("LINE push network error for", order.orderNo);
    appendOrderLog({ ...order, linePushStatus: 0, linePushOk: false });
    return json(res, 502, { ok: false, error: "notify_failed", orderNo: order.orderNo });
  }

  console.log("order", order.orderNo, "LINE push", push.status);
  appendOrderLog({
    ...order,
    linePushStatus: push.status,
    linePushOk: push.ok,
  });

  if (!push.ok) {
    return json(res, 502, { ok: false, error: "notify_failed", orderNo: order.orderNo });
  }
  return json(res, 200, { ok: true, orderNo: order.orderNo });
}

function safeJoinPublic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch (_) {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = decoded === "/" ? "/index.html" : decoded;
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!abs.startsWith(PUBLIC_DIR + path.sep) && abs !== PUBLIC_DIR) return null;
  const relFromRoot = path.relative(PUBLIC_DIR, abs);
  const parts = relFromRoot.split(path.sep);
  if (parts.some((p) => p.startsWith("."))) return null;
  const top = parts[0];
  if (PUBLIC_FILES.has(relFromRoot) || PUBLIC_DIRS.has(top)) return abs;
  return null;
}

function serveStatic(req, res) {
  const file = safeJoinPublic(req.url || "/");
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(err.code === "ENOENT" ? "Not found" : "Error");
      return;
    }
    var cacheControl = "public, max-age=3600";
    if (ext === ".html") cacheControl = "no-cache";
    else if (ext === ".js" || ext === ".css") cacheControl = "public, max-age=120, must-revalidate";
    res.writeHead(200, {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": cacheControl,
    });
    res.end(data);
  });
}

function createServer() {
  return http.createServer((req, res) => {
  const url = req.url || "/";
  const method = req.method || "GET";

  if (method === "GET" && (url === "/api/health" || url.startsWith("/api/health?"))) {
    return json(res, 200, { ok: true });
  }

  if (url.split("?")[0] === "/api/order") {
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }
    if (method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return handleOrder(req, res).catch((err) => {
      console.error("order handler error");
      if (!res.headersSent) json(res, 500, { ok: false, error: "server_error" });
    });
  }

  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Method not allowed");
  }
  return serveStatic(req, res);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log("listening on " + HOST + ":" + PORT);
  });
}

module.exports = {
  createServer,
  validateAndBuild,
  formatOrderText,
  parseItems,
  formatItemLine,
  PLANS,
  SHIPPING_FEE,
  FREE_SHIPPING_AT,
};

process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err && err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection");
});
