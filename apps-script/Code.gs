/**
 * 大又持久錠 — 訂單 Google Sheet webhook（v3：推薦碼）
 *
 * 部署後以 doPost 接收 JSON：{ secret, action, ... }
 * Script Property：SHARED_SECRET（必填，否則一律拒絕）
 *
 * action：
 *   checkAndRecord      v2 相容：記錄訂單，回 { ok, isFirstPurchase, couponStatus, suspectedDuplicate }
 *   checkAndRecordV3    記錄訂單＋推薦碼綁定／9 折／推薦人回饋金，另回 referral、myReferralCode
 *   lookupReferral      只查詢不寫入：{ phone, code } → { bound, codeStatus, applies }
 *
 * couponStatus：valid | used | phone_mismatch | not_found | not_first | ""（未使用折抵券）
 * referral.status：none | bound | bound_now | ignored_already_bound | not_found | own_code | circular
 *
 * 規則：
 *   - 每支手機下單後都會有一組 6 碼推薦碼（不含 0/O/1/I），存在 Members 分頁。
 *   - 尚未綁定的手機輸入有效推薦碼（不是自己的）→ 永久綁定，之後不可更換。
 *   - 已綁定手機的每一筆訂單打 9 折（商品小計 10%，四捨五入到元）；
 *     但同一筆若使用 NT$250 首購折抵券，就不打 9 折（二擇一）。
 *   - 推薦人回饋金 = 客人實付商品金額（扣掉 9 折或折抵券，不含運費）× 10%，四捨五入到元，
 *     累加到推薦人的 Members「累積回饋金」。回饋金只記帳，折抵請客服手動處理並填「已折抵回饋金」。
 */

var SHEET_NAME = "Orders";
var MEMBERS_SHEET = "Members";

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
  "輸入推薦碼",
  "推薦狀態",
  "綁定推薦碼",
  "推薦9折",
  "推薦人回饋金",
  "客人推薦碼",
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
  refEntered: 17,
  refStatus: 18,
  refBound: 19,
  refDiscount: 20,
  refRebate: 21,
  myCode: 22,
};

var MEMBER_HEADERS = [
  "手機",
  "推薦碼",
  "綁定推薦碼",
  "綁定推薦人手機",
  "建立時間",
  "綁定時間",
  "累積回饋金",
  "已折抵回饋金",
  "回饋金餘額",
  "首筆訂單",
];

var MCOL = {
  phone: 0,
  code: 1,
  boundCode: 2,
  boundPhone: 3,
  created: 4,
  boundAt: 5,
  rebate: 6,
  used: 7,
  balance: 8,
  firstOrder: 9,
};

var REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 不含 0 O 1 I
var REF_LEN = 6;
var REF_RE = /^[A-HJ-NP-Z2-9]{6}$/;

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
    var action = body.action;
    if (action !== "checkAndRecord" && action !== "checkAndRecordV3" && action !== "lookupReferral") {
      return jsonOut({ ok: false, error: "unknown_action" });
    }

    if (action === "lookupReferral") {
      return jsonOut(lookupReferral(body.phone, body.code));
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (action === "checkAndRecordV3") {
        return jsonOut(checkAndRecordV3(body.order || {}));
      }
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

/* ===== v2 相容 ===== */

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

/* ===== v3：推薦碼 ===== */

function checkAndRecordV3(order) {
  var sheet = getOrdersSheet();
  var rows = readDataRows(sheet);
  var msheet = getMembersSheet();
  var members = readMembers(msheet);

  var phone = normPhone(order.phone);
  var orderNo = normCode(order.orderNo);
  var name = String(order.name || "").trim();
  var store = String(order.store || "").trim();
  if (!/^09\d{8}$/.test(phone) || !orderNo) {
    throw new Error("invalid_order");
  }

  var isFirstPurchase = !hasPriorOrderForPhone(rows, phone);
  var couponStatus = evaluateCoupon(rows, order.couponCode, phone);
  var suspectedDuplicate = isSuspectedDuplicate(rows, name, store, phone);

  var entered = normRef(order.referralCode);
  var me = findMemberByPhone(members, phone);
  var res = resolveReferral(members, me, phone, entered);
  var nowText = formatTaipeiTime(order.createdAt);

  // 本人尚未有推薦碼 → 建立（每支手機一組，終身不變）
  if (!me) {
    me = {
      row: msheet.getLastRow() + 1,
      phone: phone,
      code: newReferralCode(members),
      boundCode: "",
      boundPhone: "",
      rebate: 0,
    };
    var boundCodeNew = res.status === "bound_now" ? res.referrer.code : "";
    var boundPhoneNew = res.status === "bound_now" ? res.referrer.phone : "";
    writeMemberRow(msheet, me.row, [
      phone,
      me.code,
      boundCodeNew,
      boundPhoneNew,
      nowText,
      boundCodeNew ? nowText : "",
      0,
      0,
      "",
      orderNo,
    ]);
    me.boundCode = boundCodeNew;
    me.boundPhone = boundPhoneNew;
    members.push(me);
  } else if (res.status === "bound_now") {
    msheet.getRange(me.row, MCOL.boundCode + 1, 1, 2).setValues([[res.referrer.code, res.referrer.phone]]);
    msheet.getRange(me.row, MCOL.boundAt + 1).setValue(nowText);
    me.boundCode = res.referrer.code;
    me.boundPhone = res.referrer.phone;
  }

  var isBound = res.status === "bound" || res.status === "bound_now" || res.status === "ignored_already_bound";
  var subtotal = num(order.subtotal);
  var couponDiscount = num(order.couponDiscount != null ? order.couponDiscount : order.discount);
  var couponUsed = !!normCode(order.couponCode) && couponDiscount > 0;
  var price = computeReferralPricing(subtotal, couponDiscount, num(order.shippingFee), isBound, couponUsed);

  if (isBound && price.rebate > 0 && res.referrer && res.referrer.row > 1) {
    var newTotal = num(res.referrer.rebate) + price.rebate;
    msheet.getRange(res.referrer.row, MCOL.rebate + 1).setValue(newTotal);
    res.referrer.rebate = newTotal;
  }

  var referral = {
    status: res.status,
    enteredCode: entered,
    boundCode: isBound ? res.referrer.code : "",
    boundNow: res.status === "bound_now",
    applied: price.referralDiscount > 0,
    discount: price.referralDiscount,
    rebate: price.rebate,
  };

  sheet.appendRow(buildRow(order, {
    isFirstPurchase: isFirstPurchase,
    couponStatus: couponStatus,
    discount: price.discount,
    total: price.total,
    referral: referral,
    myCode: me.code,
  }));

  return {
    ok: true,
    version: 3,
    isFirstPurchase: isFirstPurchase,
    couponStatus: couponStatus,
    suspectedDuplicate: suspectedDuplicate,
    referral: referral,
    myReferralCode: me.code,
  };
}

function lookupReferral(rawPhone, rawCode) {
  var phone = normPhone(rawPhone);
  var entered = normRef(rawCode);
  if (!/^09\d{8}$/.test(phone)) return { ok: false, error: "invalid_phone" };
  var msheet = getMembersSheet();
  var members = readMembers(msheet);
  var me = findMemberByPhone(members, phone);
  var res = resolveReferral(members, me, phone, entered);
  var bound = res.status === "bound" || res.status === "ignored_already_bound";
  var codeStatus = res.status === "bound_now" ? "valid" : res.status;
  return {
    ok: true,
    version: 3,
    bound: bound,
    codeStatus: codeStatus,
    applies: bound || codeStatus === "valid",
  };
}

// 決定這筆訂單的推薦關係（不寫入）
function resolveReferral(members, me, phone, entered) {
  if (me && me.boundCode) {
    var referrer = findMemberByCode(members, me.boundCode) || {
      row: 0, code: me.boundCode, phone: me.boundPhone, rebate: 0,
    };
    if (entered && entered !== me.boundCode) return { status: "ignored_already_bound", referrer: referrer };
    return { status: "bound", referrer: referrer };
  }
  if (!entered) return { status: "none", referrer: null };
  if (!REF_RE.test(entered)) return { status: "not_found", referrer: null };
  var ref = findMemberByCode(members, entered);
  if (!ref) return { status: "not_found", referrer: null };
  if (ref.phone === phone) return { status: "own_code", referrer: null };
  if (ref.boundPhone && ref.boundPhone === phone) return { status: "circular", referrer: null };
  return { status: "bound_now", referrer: ref };
}

function computeReferralPricing(subtotal, couponDiscount, shippingFee, isBound, couponUsed) {
  var referralDiscount = isBound && !couponUsed ? Math.round(subtotal / 10) : 0;
  var discount = (couponUsed ? couponDiscount : 0) + referralDiscount;
  var productsPaid = Math.max(0, subtotal - discount);
  var rebate = isBound ? Math.round(productsPaid / 10) : 0;
  return {
    referralDiscount: referralDiscount,
    discount: discount,
    productsPaid: productsPaid,
    rebate: rebate,
    total: productsPaid + shippingFee,
  };
}

function getMembersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MEMBERS_SHEET);
  if (!sheet) sheet = ss.insertSheet(MEMBERS_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, MEMBER_HEADERS.length).setValues([MEMBER_HEADERS]);
    sheet.setFrozenRows(1);
  }
  // 手機、推薦碼、推薦人手機存成純文字，保留開頭 0
  sheet.getRange("A:D").setNumberFormat("@");
  return sheet;
}

function readMembers(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, MEMBER_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var p = normPhone(r[MCOL.phone]);
    if (!p) continue;
    out.push({
      row: i + 2,
      phone: p,
      code: normRef(r[MCOL.code]),
      boundCode: normRef(r[MCOL.boundCode]),
      boundPhone: normPhone(r[MCOL.boundPhone]),
      rebate: num(r[MCOL.rebate]),
    });
  }
  return out;
}

function writeMemberRow(sheet, row, values) {
  values[MCOL.balance] = "=G" + row + "-H" + row;
  sheet.getRange(row, 1, 1, MEMBER_HEADERS.length).setValues([values]);
}

function findMemberByPhone(members, phone) {
  for (var i = 0; i < members.length; i++) if (members[i].phone === phone) return members[i];
  return null;
}

function findMemberByCode(members, code) {
  if (!code) return null;
  for (var i = 0; i < members.length; i++) if (members[i].code === code) return members[i];
  return null;
}

function newReferralCode(members) {
  var used = {};
  for (var i = 0; i < members.length; i++) used[members[i].code] = true;
  for (var tries = 0; tries < 200; tries++) {
    var s = "";
    for (var k = 0; k < REF_LEN; k++) {
      s += REF_ALPHABET.charAt(Math.floor(Math.random() * REF_ALPHABET.length));
    }
    if (!used[s]) return s;
  }
  throw new Error("code_space_exhausted");
}

/**
 * 選用：在 Apps Script 編輯器手動執行一次，替 Orders 裡已下單、但還沒有推薦碼的手機補發推薦碼。
 * 不會改動既有推薦碼或綁定。
 */
function backfillMembers() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readDataRows(getOrdersSheet());
    var msheet = getMembersSheet();
    var members = readMembers(msheet);
    var added = 0;
    for (var i = 0; i < rows.length; i++) {
      var phone = normPhone(rows[i][COL.phone]);
      if (!/^09\d{8}$/.test(phone) || findMemberByPhone(members, phone)) continue;
      var m = { row: msheet.getLastRow() + 1, phone: phone, code: newReferralCode(members), boundCode: "", boundPhone: "", rebate: 0 };
      writeMemberRow(msheet, m.row, [phone, m.code, "", "", formatTaipeiTime(""), "", 0, 0, "", normCode(rows[i][COL.orderNo])]);
      members.push(m);
      added++;
    }
    return added;
  } finally {
    lock.releaseLock();
  }
}

/* ===== 共用 ===== */

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
    } else {
      var lastHeader = String(sheet.getRange(1, HEADERS.length).getValue() || "").trim();
      if (lastHeader !== HEADERS[HEADERS.length - 1]) {
        // v2 表頭只有 17 欄：補上推薦碼欄位
        sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      }
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
  var ref = result.referral || null;
  var row = [
    formatTaipeiTime(order.createdAt),
    normCode(order.orderNo),
    String(order.name || "").trim(),
    normPhone(order.phone),
    String(order.store || "").trim(),
    formatItems(order),
    num(order.subtotal),
    num(order.shippingFee),
    result.discount != null ? result.discount : num(order.discount),
    result.total != null ? result.total : num(order.total),
    result.isFirstPurchase ? "是" : "否",
    issued,
    usedCode,
    status,
    String(order.couponFeedback || "").trim(),
    consent,
    String(order.notes || "").trim(),
  ];
  if (ref) {
    row.push(
      ref.enteredCode || "",
      ref.status || "",
      ref.boundCode || "",
      ref.discount || 0,
      ref.rebate || 0,
      result.myCode || ""
    );
  }
  return row;
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

function normRef(s) {
  return String(s || "").replace(/[\s-]/g, "").toUpperCase();
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
