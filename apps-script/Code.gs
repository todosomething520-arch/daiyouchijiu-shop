/**
 * 大又持久錠 — 訂單 Google Sheet webhook
 *
 * 部署後以 doPost 接收 JSON：
 *   { secret, action: "checkAndRecord", order: { ... } }
 * Script Property：SHARED_SECRET（必填，否則一律拒絕）
 *
 * 回傳：{ ok, isFirstPurchase, couponStatus, suspectedDuplicate }
 * couponStatus：valid | used | phone_mismatch | not_found | not_first | ""（未使用折抵券）
 */

var SHEET_NAME = "Orders";
var HEADERS = [
  "時間",
  "訂單編號",
  "姓名",
  "手機",
  "取貨門市",
  "品項",
  "小計",
  "運費",
  "折抵",
  "總計",
  "是否首購",
  "發券",
  "使用折抵券",
  "折抵券狀態",
  "使用心得",
  "刊登同意",
  "備註",
];

var COL = {
  time: 0,
  orderNo: 1,
  name: 2,
  phone: 3,
  store: 4,
  items: 5,
  subtotal: 6,
  shipping: 7,
  discount: 8,
  total: 9,
  isFirst: 10,
  issued: 11,
  couponCode: 12,
  couponStatus: 13,
  feedback: 14,
  consent: 15,
  notes: 16,
};

function doGet() {
  return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    var expected = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : "";
    var body = raw ? JSON.parse(raw) : {};
    if (!expected || !body || body.secret !== expected) {
      return jsonOut({ ok: false, error: "unauthorized" });
    }
    if (body.action !== "checkAndRecord") {
      return jsonOut({ ok: false, error: "unknown_action" });
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var result = checkAndRecord(body.order || {});
      return jsonOut({
        ok: true,
        isFirstPurchase: result.isFirstPurchase,
        couponStatus: result.couponStatus,
        suspectedDuplicate: result.suspectedDuplicate,
      });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonOut({ ok: false, error: "server_error" });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkAndRecord(order) {
  var sheet = getOrdersSheet();
  var rows = readDataRows(sheet);

  var phone = normPhone(order.phone);
  var orderNo = normCode(order.orderNo);
  var name = String(order.name || "").trim();
  var store = String(order.store || "").trim();
  if (!phone || !orderNo) {
    throw new Error("invalid_order");
  }

  var isFirstPurchase = !hasPriorOrderForPhone(rows, phone);
  var couponStatus = evaluateCoupon(rows, order.couponCode, phone);
  var suspectedDuplicate = isSuspectedDuplicate(rows, name, store, phone);

  sheet.appendRow(buildRow(order, {
    isFirstPurchase: isFirstPurchase,
    couponStatus: couponStatus,
  }));

  return {
    isFirstPurchase: isFirstPurchase,
    couponStatus: couponStatus,
    suspectedDuplicate: suspectedDuplicate,
  };
}

function getOrdersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  } else {
    var first = String(sheet.getRange(1, 1).getValue() || "").trim();
    if (first !== "時間") {
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      sheet.setFrozenRows(1);
    }
  }
  // Keep leading zeros on phone numbers (column D).
  sheet.getRange("D:D").setNumberFormat("@");
  return sheet;
}

function readDataRows(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
}

function hasPriorOrderForPhone(rows, phone) {
  for (var i = 0; i < rows.length; i++) {
    if (normPhone(rows[i][COL.phone]) === phone) return true;
  }
  return false;
}

function evaluateCoupon(rows, rawCode, phone) {
  var code = normCode(rawCode);
  if (!code) return "";

  var source = null;
  for (var i = 0; i < rows.length; i++) {
    if (normCode(rows[i][COL.orderNo]) === code) {
      source = rows[i];
      break;
    }
  }
  if (!source) return "not_found";
  if (normPhone(source[COL.phone]) !== phone) return "phone_mismatch";
  if (String(source[COL.isFirst] || "").trim() !== "是") return "not_first";

  for (var j = 0; j < rows.length; j++) {
    var usedCode = normCode(rows[j][COL.couponCode]);
    var usedStatus = String(rows[j][COL.couponStatus] || "").trim();
    if (usedCode === code && usedStatus === "valid") return "used";
  }
  return "valid";
}

function isSuspectedDuplicate(rows, name, store, phone) {
  var key = personKey(name, store);
  if (!key) return false;
  for (var i = 0; i < rows.length; i++) {
    var prevPhone = normPhone(rows[i][COL.phone]);
    if (!prevPhone || prevPhone === phone) continue;
    if (personKey(rows[i][COL.name], rows[i][COL.store]) === key) return true;
  }
  return false;
}

function buildRow(order, result) {
  var issued = result.isFirstPurchase ? normCode(order.orderNo) : "";
  var code = normCode(order.couponCode);
  var status = result.couponStatus || "";
  var usedCode = code;
  var consent = "";
  if (code) consent = order.publishConsent ? "是" : "否";
  return [
    formatTaipeiTime(order.createdAt),
    normCode(order.orderNo),
    String(order.name || "").trim(),
    normPhone(order.phone),
    String(order.store || "").trim(),
    formatItems(order),
    num(order.subtotal),
    num(order.shippingFee),
    num(order.discount),
    num(order.total),
    result.isFirstPurchase ? "是" : "否",
    issued,
    usedCode,
    status,
    String(order.couponFeedback || "").trim(),
    consent,
    String(order.notes || "").trim(),
  ];
}

function formatItems(order) {
  if (order.itemsText) return String(order.itemsText);
  var items = order.items || [];
  var parts = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) continue;
    if (it.bulk) {
      parts.push("批量 × " + it.tabletTotal + " 錠");
    } else {
      parts.push((it.planName || "") + " × " + it.quantity + " 組（共 " + it.tabletTotal + " 錠）");
    }
  }
  return parts.join("；");
}

function formatTaipeiTime(iso) {
  var d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  return Utilities.formatDate(d, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
}

function normPhone(s) {
  var p = String(s || "").replace(/[\s-]/g, "");
  // Sheets may coerce 09xxxxxxxx to a number and drop the leading zero.
  if (/^9\d{8}$/.test(p)) p = "0" + p;
  return p;
}

function normCode(s) {
  return String(s || "").trim().toUpperCase();
}

function personKey(name, store) {
  var n = String(name || "").replace(/\s+/g, "");
  var s = String(store || "").replace(/\s+/g, "");
  if (!n || !s) return "";
  return n + "\t" + s;
}

function num(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}
