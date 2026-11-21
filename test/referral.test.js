/**
 * 推薦碼功能本機測試：在 Node vm 裡跑真正的 apps-script/Code.gs（模擬 SpreadsheetApp 等），
 * 用本機 HTTP 假裝 Apps Script web app（含 302 轉址），攔截 LINE push（不會真的送出）。
 * 執行：node test/referral.test.js [舊版Code.gs路徑]
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");

process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
process.env.LINE_USER_ID = "Utest";
process.env.LINE_CHANNEL_SECRET = "test-secret";
process.env.SECRETS_DIR = "/nonexistent";
process.env.DATA_DIR = "/tmp/referral-test-data";
const SECRET = "unit-test-secret";

/* ---------- 模擬 Apps Script ---------- */
function makeSheet(name) {
  const data = []; // rows of arrays
  const textCols = new Set();
  function coerce(v, col) {
    // Sheets 會把 0912345678 變成數字 912345678，除非欄位是純文字
    if (typeof v === "string" && /^0\d{9}$/.test(v) && !textCols.has(col)) return Number(v);
    return v;
  }
  function colLetterRange(a1) {
    const m = /^([A-Z]):([A-Z])$/.exec(a1);
    const s = m[1].charCodeAt(0) - 65, e = m[2].charCodeAt(0) - 65;
    return [s, e];
  }
  const sheet = {
    name,
    data,
    getLastRow: () => data.length,
    setFrozenRows() {},
    insertRowBefore(r) { data.splice(r - 1, 0, []); },
    appendRow(vals) { data.push(vals.map((v, i) => coerce(v, i))); },
    getRange(a, b, nr, nc) {
      if (typeof a === "string") {
        const [s, e] = colLetterRange(a);
        return { setNumberFormat() { for (let c = s; c <= e; c++) textCols.add(c); } };
      }
      nr = nr || 1; nc = nc || 1;
      const r0 = a - 1, c0 = b - 1;
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < nr; r++) {
            const row = [];
            for (let c = 0; c < nc; c++) {
              const v = data[r0 + r] ? data[r0 + r][c0 + c] : undefined;
              row.push(v == null ? "" : v);
            }
            out.push(row);
          }
          return out;
        },
        getValue() { return this.getValues()[0][0]; },
        setValues(vals) {
          for (let r = 0; r < nr; r++) {
            while (data.length < r0 + r + 1) data.push([]);
            for (let c = 0; c < nc; c++) data[r0 + r][c0 + c] = coerce(vals[r][c], c0 + c);
          }
        },
        setValue(v) { this.setValues([[v]]); },
      };
    },
  };
  return sheet;
}

function loadScript(file, existingSheets) {
  const sheets = existingSheets || {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => SECRET }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: "json", TEXT: "text" },
      createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }),
    },
    Utilities: { formatDate: (d) => d.toISOString().replace("T", " ").slice(0, 19) },
    JSON, Math, Date, String, Number, Object, Error, isNaN, isFinite,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, "utf8"), ctx);
  return { ctx, sheets };
}

/* ---------- 假 webhook ---------- */
let script = null;
let sheetDown = false;
const hookServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/echo/")) {
    const body = decodeURIComponent(req.url.slice(6));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (sheetDown) { res.writeHead(500); return res.end("down"); }
    const out = script.ctx.doPost({ postData: { contents: raw } });
    res.writeHead(302, { Location: "/echo/" + encodeURIComponent(out.text) });
    res.end();
  });
});

/* ---------- 攔截 LINE ---------- */
const realFetch = global.fetch;
const linePushes = [];
global.fetch = async (url, opts) => {
  if (String(url).startsWith("https://api.line.me/")) {
    linePushes.push(JSON.parse(opts.body).messages[0].text);
    return new Response(JSON.stringify({}), { status: 200 });
  }
  return realFetch(url, opts);
};

const srv = require("../server.js");

async function main() {
  await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
  process.env.SHEET_WEBHOOK_URL = "http://127.0.0.1:" + hookServer.address().port + "/exec";
  process.env.SHEET_SECRET = SECRET;
  const app = srv.createServer();
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.address().port;
  let ipN = 0;
  async function post(pathname, body) {
    const res = await realFetch(base + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0." + (++ipN) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  function order(phone, extra) {
    return Object.assign({ items: [{ plan: "pbulk", qty: 10 }], name: "測試" + phone.slice(-3), phone, store: "測試門市" + phone.slice(-3) }, extra || {});
  }
  const results = [];
  async function t(name, fn) {
    try { await fn(); results.push("PASS " + name); }
    catch (e) { results.push("FAIL " + name + " — " + e.message); }
  }

  /* ===== v3 腳本 ===== */
  script = loadScript(path.join(__dirname, "..", "apps-script", "Code.gs"));
  let codeA, codeB;

  await t("A first order (no code) → no discount, gets own code", async () => {
    const r = await post("/api/order", order("0911000001"));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.pricing.total, 2060);
    assert.strictEqual(r.body.pricing.referralDiscount, 0);
    assert.match(r.body.myReferralCode, /^[A-HJ-NP-Z2-9]{6}$/);
    codeA = r.body.myReferralCode;
    const line = linePushes.at(-1);
    assert.ok(line.includes("客人專屬推薦碼：" + codeA), line);
    assert.ok(!line.includes("待人工確認"));
  });

  await t("lookup: B with A's code → valid / applies", async () => {
    const r = await post("/api/referral/check", { phone: "0922000002", code: codeA.toLowerCase() });
    assert.deepStrictEqual(r.body, { ok: true, available: true, bound: false, codeStatus: "valid", applies: true });
  });

  await t("B new customer with A's code → bound, 9折, A rebate 10% of paid", async () => {
    const r = await post("/api/order", order("0922000002", { referralCode: codeA.slice(0, 3) + "-" + codeA.slice(3).toLowerCase() }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.pricing.referralDiscount, 200);
    assert.strictEqual(r.body.pricing.total, 1800 + 60);
    assert.strictEqual(r.body.referral.status, "bound_now");
    assert.strictEqual(r.body.referral.applied, true);
    codeB = r.body.myReferralCode;
    assert.ok(codeB && codeB !== codeA);
    const line = linePushes.at(-1);
    assert.ok(line.includes("推薦碼：" + codeA + "（本單新綁定✅）"), line);
    assert.ok(line.includes("推薦 9 折：-NT$200"), line);
    assert.ok(line.includes("推薦人回饋金：NT$180"), line);
    assert.ok(line.includes("應付：NT$1,860"), line);
    const m = script.sheets.Members.data;
    const rowB = m.find((r) => String(r[1]) === codeB);
    assert.strictEqual(String(rowB[0]), "0922000002", "phone kept as text with leading 0");
    assert.strictEqual(rowB[2], codeA);
    const rowA = m.find((r) => String(r[1]) === codeA);
    assert.strictEqual(rowA[6], 180);
  });

  await t("B repeat order without code → still 9折; A rebate accumulates", async () => {
    const r = await post("/api/order", order("0922000002", { items: [{ plan: "p5", qty: 1 }] }));
    assert.strictEqual(r.body.pricing.referralDiscount, 110);
    assert.strictEqual(r.body.pricing.total, 990 + 60);
    assert.strictEqual(r.body.referral.status, "bound");
    assert.strictEqual(r.body.myReferralCode, codeB, "own code stable");
    const rowA = script.sheets.Members.data.find((r) => String(r[1]) === codeA);
    assert.strictEqual(rowA[6], 180 + 99);
    assert.ok(linePushes.at(-1).includes("已綁定推薦碼：" + codeA + "（回購自動 9 折）"));
  });

  await t("lookup: bound phone without code → bound/applies", async () => {
    const r = await post("/api/referral/check", { phone: "0922000002", code: "" });
    assert.strictEqual(r.body.bound, true);
    assert.strictEqual(r.body.applies, true);
  });

  let codeC;
  await t("C (new) orders, then B enters C's code later → ignored, binding stays A", async () => {
    const c = await post("/api/order", order("0933000003", { items: [{ plan: "p1", qty: 1 }] }));
    codeC = c.body.myReferralCode;
    const r = await post("/api/order", order("0922000002", { items: [{ plan: "p3", qty: 1 }], referralCode: codeC }));
    assert.strictEqual(r.body.referral.status, "ignored_already_bound");
    assert.strictEqual(r.body.pricing.referralDiscount, 70);
    const line = linePushes.at(-1);
    assert.ok(line.includes("輸入推薦碼 " + codeC + " 已忽略（此手機已綁定 " + codeA + "）"), line);
    assert.ok(line.includes("推薦人回饋金：NT$63（推薦人 " + codeA + "，已記入試算表）"), line);
    const rowB = script.sheets.Members.data.find((r) => String(r[1]) === codeB);
    assert.strictEqual(rowB[2], codeA);
    const rowC = script.sheets.Members.data.find((r) => String(r[1]) === codeC);
    assert.strictEqual(Number(rowC[6] || 0), 0, "C earns nothing");
  });

  await t("own code → rejected, normal price", async () => {
    const r = await post("/api/order", order("0933000003", { items: [{ plan: "p1", qty: 1 }], referralCode: codeC }));
    assert.strictEqual(r.body.referral.status, "own_code");
    assert.strictEqual(r.body.pricing.referralDiscount, 0);
    assert.strictEqual(r.body.pricing.total, 310);
    assert.ok(linePushes.at(-1).includes("無效（不可使用自己的推薦碼），未打折"));
    const look = await post("/api/referral/check", { phone: "0933000003", code: codeC });
    assert.strictEqual(look.body.codeStatus, "own_code");
    assert.strictEqual(look.body.applies, false);
  });

  await t("circular binding (A enters B's code) → rejected", async () => {
    const r = await post("/api/order", order("0911000001", { referralCode: codeB }));
    assert.strictEqual(r.body.referral.status, "circular");
    assert.strictEqual(r.body.pricing.referralDiscount, 0);
  });

  await t("unknown well-formed code → not_found, normal price; malformed → 400", async () => {
    const r = await post("/api/order", order("0944000004", { referralCode: "ZZZZZZ" }));
    assert.strictEqual(r.body.referral.status, "not_found");
    assert.strictEqual(r.body.pricing.total, 2060);
    const bad = await post("/api/order", order("0944000004", { referralCode: "AB0O1I" }));
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error, "invalid_referral_code");
  });

  await t("coupon + referral conflict: bound B uses first-purchase coupon → coupon only, no 9折, rebate on paid", async () => {
    // D: new, binds to A, first order → coupon code = D's first order no
    const d1 = await post("/api/order", order("0955000005", { items: [{ plan: "p1", qty: 1 }], referralCode: codeA }));
    assert.strictEqual(d1.body.pricing.referralDiscount, 25);
    assert.strictEqual(d1.body.pricing.total, 225 + 60);
    const coupon = d1.body.orderNo;
    const d2 = await post("/api/order", order("0955000005", {
      items: [{ plan: "p3", qty: 1 }],
      couponCode: coupon,
      couponFeedback: "這是一段超過三十個字的使用心得測試內容，用來確認折抵券與推薦九折不會同時套用的情況。",
      publishConsent: false,
      discountChoice: "coupon",
    }));
    assert.strictEqual(d2.status, 200, JSON.stringify(d2.body));
    assert.strictEqual(d2.body.pricing.couponDiscount, 250);
    assert.strictEqual(d2.body.pricing.referralDiscount, 0);
    assert.strictEqual(d2.body.pricing.total, 450 + 60);
    const line = linePushes.at(-1);
    assert.ok(line.includes("券有效✅"), line);
    assert.ok(line.includes("本單使用折抵券，不套用推薦 9 折"), line);
    assert.ok(line.includes("推薦人回饋金：NT$45"), line);
    const orders = script.sheets.Orders.data;
    const last = orders.at(-1);
    assert.strictEqual(last[8], 250);   // 折抵
    assert.strictEqual(last[9], 510);   // 總計
    assert.strictEqual(last[20], 0);    // 推薦9折
    assert.strictEqual(last[21], 45);   // 回饋金
  });

  await t("free shipping judged on pre-discount subtotal (3000 → 9折 2700, still free)", async () => {
    const r = await post("/api/order", order("0922000002", { items: [{ plan: "pbulk", qty: 15 }] }));
    assert.strictEqual(r.body.pricing.shippingFee, 0);
    assert.strictEqual(r.body.pricing.total, 2700);
  });

  await t("Orders header extended & sheet totals match server", async () => {
    const hdr = script.sheets.Orders.data[0];
    assert.strictEqual(hdr.length, 23);
    assert.strictEqual(hdr[22], "客人推薦碼");
  });

  /* ===== 試算表掛掉 ===== */
  await t("sheet down → order accepted at normal price, LINE flags 待人工確認, pending to client", async () => {
    sheetDown = true;
    const r = await post("/api/order", order("0922000002", { referralCode: codeA }));
    sheetDown = false;
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.pricing.referralDiscount, 0);
    assert.strictEqual(r.body.pricing.total, 2060);
    assert.strictEqual(r.body.referral.pending, true);
    assert.strictEqual(r.body.myReferralCode, "");
    const line = linePushes.at(-1);
    assert.ok(line.includes("⚠️ 推薦碼 " + codeA + " 待人工確認"), line);
    assert.ok(line.includes("若為首購→此單號即折抵券"), line);
    const look = await (async () => { sheetDown = true; const x = await post("/api/referral/check", { phone: "0922000002", code: "" }); sheetDown = false; return x; })();
    assert.deepStrictEqual(look.body, { ok: true, available: false });
  });

  /* ===== 舊版 v2 腳本仍在線上 ===== */
  const legacyFile = process.argv[2];
  if (legacyFile) {
    script = loadScript(legacyFile);
    await t("legacy v2 script → falls back to checkAndRecord; row logged; referral pending", async () => {
      const r = await post("/api/order", order("0966000006", { referralCode: "ABCDEF" }));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.pricing.total, 2060);
      assert.strictEqual(r.body.referral.pending, true);
      assert.strictEqual(script.sheets.Orders.data.length, 2, "exactly one order row (header + 1)");
      const line = linePushes.at(-1);
      assert.ok(line.includes("首購✅ 已發 NT$250 折抵券"), line);
      assert.ok(line.includes("⚠️ 推薦碼 ABCDEF 待人工確認"), line);
      const look = await post("/api/referral/check", { phone: "0966000006", code: "" });
      assert.deepStrictEqual(look.body, { ok: true, available: false });
    });
  }

  if (legacyFile) {
    await t("upgrade: v3 script on a v2 sheet → header extended, old customer gets code on next order", async () => {
      script = loadScript(path.join(__dirname, "..", "apps-script", "Code.gs"), script.sheets);
      const r = await post("/api/order", order("0966000006", { items: [{ plan: "p1", qty: 1 }] }));
      assert.strictEqual(r.body.referral.status, "none");
      assert.match(r.body.myReferralCode, /^[A-HJ-NP-Z2-9]{6}$/);
      const hdr = script.sheets.Orders.data[0];
      assert.strictEqual(hdr.length, 23);
      assert.ok(linePushes.at(-1).includes("非首購"), "first-purchase still detected from v2 rows (leading 0 restored)");
    });
  }

  console.log(results.join("\n"));
  console.log("\n--- sample LINE text (B first order) ---\n" + linePushes[1]);
  app.close(); hookServer.close();
  if (results.some((x) => x.startsWith("FAIL"))) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
