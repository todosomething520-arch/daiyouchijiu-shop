/**
 * 大又持久錠 — 一頁式結帳
 * 送出訂單時 POST /api/order（由後端驗證、計價並通知賣家）。
 * 請勿在前端放置 LINE token。
 */

/* ========== 可調整設定 ========== */
const SHIPPING_FEE = 60; // 7-11 賣貨便運費（新台幣）；以後端重算為準
const FREE_SHIPPING_AT = 3000; // 商品金額滿此金額免運
const COUPON_DISCOUNT = 250; // 首購折抵券金額；以後端重算為準
const COUPON_MIN_SUBTOTAL = 700; // 折抵門檻（商品小計，折抵前）
const COUPON_FEEDBACK_MIN = 30;
const COUPON_FEEDBACK_MAX = 1000;
const COUPON_CODE_RE = /^DY\d{6}-\d{3}$/;
const PROMO_TEXT = "首購即送 NT$250 折抵券：下次購買附上使用心得，可全額折抵 NT$250";
const LINE_OA_URL = "https://line.me/R/ti/p/@997baoaw"; // 官方帳號加好友連結
const LINE_OA_ID = "@997baoaw"; // 官方帳號 ID（可搜尋）
const ORDER_API = "/api/order";
const REFERRAL_CHECK_API = "/api/referral/check";
const REFERRAL_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/; // 6 碼，不含 0 O 1 I
const REBATE_NOTE = "回饋金僅可作為購物金，不可兌換現金，請洽 LINE 客服折抵。";

const PLANS = [
  { id: "p1", name: "1錠體驗", tablets: 1, price: 250, desc: "嘗鮮入門", unit: 250 },
  { id: "p3", name: "3錠組", tablets: 3, price: 700, desc: "輕量補充", unit: 233, save: 50 },
  { id: "p5", name: "5錠組", tablets: 5, price: 1100, desc: "熱銷推薦", unit: 220, save: 150, popular: true },
  {
    id: "pbulk",
    name: "批量優惠",
    lineName: "批量",
    bulk: true,
    unit: 200,
    desc: "最低 10 錠起",
    hint: "15 錠 NT$3,000 免運",
    badge: "批量優惠",
    featured: true,
    qtyMin: 10,
    qtyMax: 100,
  },
];

const state = {
  cart: {}, // planId -> qty
  pendingOrder: null,
  lastOrder: null,
  referralLookup: null, // { key, result }，結帳頁預估用；以送出後伺服器結果為準
};

/* ========== 工具 ========== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function money(n) {
  return "NT$" + Math.round(n).toLocaleString("zh-TW");
}

function planById(id) {
  return PLANS.find((p) => p.id === id) || null;
}

function isBulk(plan) {
  return !!(plan && plan.bulk);
}

function qtyLimits(plan) {
  if (isBulk(plan)) return { min: plan.qtyMin, max: plan.qtyMax };
  return { min: 1, max: 20 };
}

function defaultQty(plan) {
  return qtyLimits(plan).min;
}

function clampQtyFor(plan, n) {
  const limits = qtyLimits(plan);
  const q = Math.floor(Number(n));
  if (!Number.isFinite(q)) return limits.min;
  return Math.min(limits.max, Math.max(limits.min, q));
}

function buildLine(p, qty) {
  if (isBulk(p)) {
    return {
      planId: p.id,
      planName: p.lineName,
      bulk: true,
      tabletsEach: 1,
      quantity: qty,
      tabletTotal: qty,
      unitPrice: p.unit,
      subtotal: p.unit * qty,
    };
  }
  return {
    planId: p.id,
    planName: p.name,
    bulk: false,
    tabletsEach: p.tablets,
    quantity: qty,
    tabletTotal: p.tablets * qty,
    unitPrice: p.price,
    subtotal: p.price * qty,
  };
}

function lineLabel(it) {
  if (it.bulk) return `批量 × ${it.tabletTotal} 錠`;
  return `${it.planName} × ${it.quantity} 組（共 ${it.tabletTotal} 錠）`;
}

function cartItems() {
  return PLANS.map((p) => {
    const qty = state.cart[p.id] || 0;
    if (qty < 1) return null;
    return buildLine(p, qty);
  }).filter(Boolean);
}

function normalizeCouponCode(raw) {
  return String(raw || "").trim().toUpperCase();
}

function isCouponCode(code) {
  return COUPON_CODE_RE.test(normalizeCouponCode(code));
}

function couponAllowed(subtotal) {
  return subtotal >= COUPON_MIN_SUBTOTAL;
}

function readCouponForm() {
  const codeEl = $("#coupon-code");
  const fbEl = $("#coupon-feedback");
  const pubEl = $("#coupon-publish");
  const code = normalizeCouponCode(codeEl ? codeEl.value : "");
  const feedback = fbEl ? String(fbEl.value || "").trim() : "";
  const publishConsent = !!(pubEl && pubEl.checked);
  const wants = !!(code || feedback);
  return { code: code, feedback: feedback, publishConsent: publishConsent, wants: wants };
}

function discountChoice() {
  const el = document.querySelector('input[name="discountChoice"]:checked');
  return el && el.value === "coupon" ? "coupon" : "referral";
}

function normalizeReferralCode(raw) {
  return String(raw || "").replace(/[\s-]/g, "").toUpperCase();
}

function readReferralCode() {
  const el = $("#referral-code");
  return normalizeReferralCode(el ? el.value : "");
}

// 預估是否可享推薦 9 折（真正結果由伺服器／試算表決定）
function referralEstimate(phone, code) {
  const look = state.referralLookup;
  const key = phone + "|" + code;
  const result = look && look.key === key ? look.result : null;
  const codeOk = REFERRAL_CODE_RE.test(code);
  if (result && result.available) {
    return { applies: !!result.applies, confirmed: true, result: result };
  }
  if (result && !result.available) {
    return { applies: codeOk, confirmed: false, unavailable: true, result: result };
  }
  return { applies: codeOk, confirmed: false, result: null };
}

function couponReady(form, allowed) {
  if (!allowed || !form.wants || discountChoice() !== "coupon") return false;
  return isCouponCode(form.code) && form.feedback.length >= COUPON_FEEDBACK_MIN && form.feedback.length <= COUPON_FEEDBACK_MAX;
}

function totals() {
  const items = cartItems();
  const subtotal = items.reduce((s, it) => s + it.subtotal, 0);
  const tabletTotal = items.reduce((s, it) => s + it.tabletTotal, 0);
  const shipping = subtotal === 0 ? 0 : subtotal >= FREE_SHIPPING_AT ? 0 : SHIPPING_FEE;
  const allowed = couponAllowed(subtotal);
  const form = readCouponForm();
  const applied = couponReady(form, allowed);
  const couponDiscount = applied ? COUPON_DISCOUNT : 0;
  const phone = normalizePhone($("#phone") ? $("#phone").value : "");
  const referralCode = readReferralCode();
  const est = referralEstimate(phone, referralCode);
  const choseCoupon = allowed && discountChoice() === "coupon";
  const referralDiscount = !choseCoupon && est.applies && subtotal > 0 ? Math.round(subtotal / 10) : 0;
  const discount = couponDiscount + referralDiscount;
  return {
    items: items,
    tabletTotal: tabletTotal,
    subtotal: subtotal,
    shipping: shipping,
    discount: discount,
    couponDiscount: couponDiscount,
    referralDiscount: referralDiscount,
    referralCode: referralCode,
    referralEstimate: est,
    couponAllowed: allowed,
    couponApplied: applied,
    couponCode: applied ? form.code : "",
    couponFeedback: applied ? form.feedback : "",
    publishConsent: applied ? form.publishConsent : false,
    total: subtotal - discount + shipping,
    free: subtotal >= FREE_SHIPPING_AT,
    remain: Math.max(0, FREE_SHIPPING_AT - subtotal),
  };
}

function normalizePhone(raw) {
  return String(raw || "").replace(/[\s-]/g, "");
}

function isTaiwanMobile(raw) {
  return /^09\d{8}$/.test(normalizePhone(raw));
}

/* ========== 方案與購物車 ========== */
function renderPlans() {
  const grid = $("#pricing-grid");
  grid.innerHTML = PLANS.map((p) => {
    const badgeText = p.badge || (p.featured ? "最划算" : p.popular ? "熱銷推薦" : "");
    const badge = badgeText ? `<div class="plan-badge">${badgeText}</div>` : "";
    const btnClass = p.featured || p.popular || p.bulk ? "btn-primary" : "btn-ghost";
    const extras = [p.featured ? "featured" : "", p.bulk ? "bulk-card" : ""].filter(Boolean).join(" ");
    const limits = qtyLimits(p);
    const start = defaultQty(p);
    const unitWord = p.bulk ? "錠數" : "組數";
    let priceBlock;
    let meta;
    let preview = "";
    if (p.bulk) {
      priceBlock = `<div class="plan-price"><span class="currency">每錠 NT$</span> <span class="amount">${p.unit.toLocaleString("zh-TW")}</span></div>`;
      meta = `<div class="plan-meta"><div>${p.desc}</div><div class="plan-hint">${p.hint}</div></div>`;
      preview = `<p class="bulk-preview" data-bulk-preview>${start} 錠 ${money(p.unit * start)}</p>`;
    } else {
      const save = p.save ? `<div>省下 ${money(p.save)}</div>` : "<div>單錠原價</div>";
      priceBlock = `<div class="plan-price"><span class="currency">NT$</span> <span class="amount">${p.price.toLocaleString("zh-TW")}</span></div>`;
      meta = `<div class="plan-meta"><div>${p.tablets} 錠（每錠約 ${money(p.unit)}）</div>${save}</div>`;
    }
    return `
      <article class="plan-card ${extras}" data-plan="${p.id}">
        ${badge}
        <h3>${p.name}</h3>
        ${p.bulk ? "" : `<p class="plan-desc">${p.desc}</p>`}
        ${priceBlock}
        ${meta}
        <div class="plan-add">
          <div class="qty-control">
            <button type="button" data-add-delta="-1" aria-label="減少 ${p.name} ${unitWord}">−</button>
            <input type="number" class="plan-qty-input" min="${limits.min}" max="${limits.max}" value="${start}" inputmode="numeric" aria-label="${p.name} ${unitWord}">
            <button type="button" data-add-delta="1" aria-label="增加 ${p.name} ${unitWord}">+</button>
          </div>
          ${preview}
          <button type="button" class="btn ${btnClass} add-to-cart">加入購物車</button>
        </div>
        <p class="in-cart-note" data-in-cart-note hidden></p>
      </article>`;
  }).join("");
}

function readCardQty(card) {
  const plan = planById(card.dataset.plan);
  const input = card.querySelector(".plan-qty-input");
  return clampQtyFor(plan, input ? input.value : defaultQty(plan));
}

function updateBulkPreview(card, qty) {
  const preview = card.querySelector("[data-bulk-preview]");
  const plan = planById(card.dataset.plan);
  if (!preview || !isBulk(plan)) return;
  const n = clampQtyFor(plan, qty);
  preview.textContent = `${n} 錠 ${money(plan.unit * n)}`;
}

function writeCardQty(card, qty) {
  const plan = planById(card.dataset.plan);
  const n = clampQtyFor(plan, qty);
  const input = card.querySelector(".plan-qty-input");
  if (input && document.activeElement !== input) input.value = String(n);
  updateBulkPreview(card, n);
  return n;
}

function addToCart(planId, qty) {
  const plan = planById(planId);
  if (!plan) return;
  const add = clampQtyFor(plan, qty);
  const maxQty = qtyLimits(plan).max;
  const current = state.cart[planId] || 0;
  const unit = isBulk(plan) ? "錠" : "組";
  if (current >= maxQty) {
    showToast(`${isBulk(plan) ? "批量" : plan.name} 最多可買 ${maxQty} ${unit}`);
    return;
  }
  const next = Math.min(maxQty, current + add);
  state.cart[planId] = next;
  updateTotals();
  const card = document.querySelector(`.plan-card[data-plan="${planId}"]`);
  if (card) writeCardQty(card, defaultQty(plan));
  if (next < current + add) {
    showToast(`${isBulk(plan) ? "批量" : plan.name} 已達 ${max} ${unit}上限`);
  } else if (isBulk(plan)) {
    showToast(`已加入購物車：批量 × ${add} 錠`);
  } else {
    showToast(`已加入購物車：${plan.name} × ${add} 組`);
  }
}

function setLineQty(planId, qty) {
  const plan = planById(planId);
  if (!plan || !state.cart[planId]) return;
  state.cart[planId] = clampQtyFor(plan, qty);
  updateTotals();
}

function removeLine(planId) {
  delete state.cart[planId];
  updateTotals();
}

function setupCartEvents() {
  const grid = $("#pricing-grid");
  if (!grid) return;
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".plan-card");
    if (!card) return;
    const planId = card.dataset.plan;
    if (e.target.closest("[data-add-delta]")) {
      const delta = Number(e.target.closest("[data-add-delta]").dataset.addDelta);
      writeCardQty(card, readCardQty(card) + delta);
      return;
    }
    if (e.target.closest(".add-to-cart")) {
      addToCart(planId, readCardQty(card));
    }
  });
  grid.addEventListener("change", (e) => {
    const input = e.target.closest(".plan-qty-input");
    if (!input) return;
    const card = input.closest(".plan-card");
    writeCardQty(card, input.value);
  });
  grid.addEventListener("input", (e) => {
    const input = e.target.closest(".plan-qty-input");
    if (!input) return;
    const card = input.closest(".plan-card");
    const plan = planById(card.dataset.plan);
    if (isBulk(plan)) updateBulkPreview(card, input.value);
  });

  const cartLines = $("#cart-lines");
  if (!cartLines) return;
  cartLines.addEventListener("click", (e) => {
    const line = e.target.closest(".cart-line");
    if (!line) return;
    const planId = line.dataset.plan;
    if (e.target.closest("[data-cart-remove]")) {
      removeLine(planId);
      return;
    }
    const deltaBtn = e.target.closest("[data-cart-delta]");
    if (deltaBtn) {
      const current = state.cart[planId] || 0;
      setLineQty(planId, current + Number(deltaBtn.dataset.cartDelta));
    }
  });
  cartLines.addEventListener("change", (e) => {
    const input = e.target.closest("[data-cart-qty]");
    if (!input) return;
    setLineQty(input.dataset.cartQty, input.value);
  });
}

function renderCartLines(items) {
  const box = $("#cart-lines");
  const empty = $("#cart-empty");
  if (!items.length) {
    box.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  box.innerHTML = items
    .map((it) => {
      const plan = planById(it.planId);
      const limits = qtyLimits(plan);
      const unitWord = it.bulk ? "錠數" : "組數";
      const title = it.bulk ? "批量優惠" : it.planName;
      return `<div class="cart-line" data-plan="${it.planId}">
        <div class="cart-line-main">
          <div class="cart-line-info">
            <strong>${title}</strong>
            <span>${lineLabel(it)}</span>
          </div>
          <span class="cart-line-sub">${money(it.subtotal)}</span>
        </div>
        <div class="cart-line-actions">
          <div class="qty-control">
            <button type="button" data-cart-delta="-1" aria-label="減少 ${title} ${unitWord}">−</button>
            <input type="number" min="${limits.min}" max="${limits.max}" value="${it.quantity}" inputmode="numeric" data-cart-qty="${it.planId}" aria-label="${title} ${unitWord}">
            <button type="button" data-cart-delta="1" aria-label="增加 ${title} ${unitWord}">+</button>
          </div>
          <button type="button" class="btn-remove" data-cart-remove="${it.planId}" aria-label="移除 ${title}">移除</button>
        </div>
      </div>`;
    })
    .join("");
}

function cartSummaryHtml(t) {
  const itemRows = t.items
    .map((it) => `<div><span>${lineLabel(it)}</span><span>${money(it.subtotal)}</span></div>`)
    .join("");
  let discountRow = t.couponDiscount
    ? `<div><span>首購折抵券</span><span>−${money(t.couponDiscount)}</span></div>`
    : "";
  if (t.referralDiscount) {
    discountRow += `<div><span>推薦碼 9 折（預估）</span><span>−${money(t.referralDiscount)}</span></div>`;
  }
  return `<div class="live-lines">
      ${itemRows}
      <div><span>商品小計（共 ${t.tabletTotal} 錠）</span><span>${money(t.subtotal)}</span></div>
      ${discountRow}
      <div><span>運費</span><span>${t.shipping ? money(t.shipping) : "免運"}</span></div>
      <div class="total"><span>應付金額</span><span>${money(t.total)}</span></div>
    </div>`;
}

function updateCouponSection(t) {
  const box = $("#coupon-box");
  if (!box) return;
  box.hidden = !t.couponAllowed;
  const fields = $("#coupon-fields");
  if (fields) fields.hidden = !(t.couponAllowed && discountChoice() === "coupon");
  const fb = $("#coupon-feedback");
  const count = $("#coupon-feedback-count");
  if (count) {
    const n = fb ? String(fb.value || "").trim().length : 0;
    count.textContent = n + " / " + COUPON_FEEDBACK_MAX + " 字（至少 " + COUPON_FEEDBACK_MIN + " 字）";
  }
}

const REFERRAL_STATUS_TEXT = {
  valid: "✅ 推薦碼有效，本單預估享 9 折；送出後綁定，之後回購也都 9 折。",
  bound: "✅ 此手機已綁定推薦碼，本單自動享 9 折。",
  ignored_already_bound: "此手機已綁定其他推薦碼（推薦碼不可更換），將沿用原推薦碼並享 9 折。",
  not_found: "查無此推薦碼，請確認後再輸入；本單將以原價計算。",
  own_code: "不可使用自己的推薦碼；本單將以原價計算。",
  circular: "此推薦碼無法使用（對方已綁定你為推薦人）；本單將以原價計算。",
};

function updateReferralStatus(t) {
  const el = $("#referral-status");
  if (!el) return;
  const est = t.referralEstimate || {};
  let text = "";
  let good = false;
  if (est.result && est.result.available) {
    const st = est.result.bound && est.result.codeStatus !== "ignored_already_bound" ? "bound" : est.result.codeStatus;
    text = REFERRAL_STATUS_TEXT[st] || "";
    good = !!est.result.applies;
  } else if (est.unavailable && REFERRAL_CODE_RE.test(t.referralCode)) {
    text = "系統暫時無法確認推薦碼，9 折將由客服確認後調整。";
  }
  if (text && good && t.couponDiscount) {
    text += "（本單選擇使用折抵券，不打 9 折）";
  }
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle("ok", good);
}

let referralTimer = null;
let referralSeq = 0;
function scheduleReferralLookup() {
  clearTimeout(referralTimer);
  referralTimer = setTimeout(runReferralLookup, 450);
}

async function runReferralLookup() {
  const phone = normalizePhone($("#phone") ? $("#phone").value : "");
  const code = readReferralCode();
  const key = phone + "|" + code;
  if (!/^09\d{8}$/.test(phone)) return;
  if (code && !REFERRAL_CODE_RE.test(code)) return;
  if (state.referralLookup && state.referralLookup.key === key) return;
  const seq = ++referralSeq;
  let result;
  try {
    const res = await fetch(REFERRAL_CHECK_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: phone, code: code }),
    });
    const data = await res.json();
    result = data && data.ok ? data : { available: false };
  } catch (err) {
    result = { available: false };
  }
  if (seq !== referralSeq) return;
  state.referralLookup = { key: key, result: result };
  updateTotals();
}

function updateTotals() {
  const t = totals();
  updateCouponSection(t);
  updateReferralStatus(t);
  renderCartLines(t.items);

  const pillLabel = t.items.length ? `商品小計（共 ${t.tabletTotal} 錠）` : "商品小計";
  const liveLabel = $("#live-plan-label");
  const liveSub = $("#live-subtotal");
  const liveShip = $("#live-shipping");
  const liveTotal = $("#live-total");
  if (liveLabel) liveLabel.textContent = pillLabel;
  if (liveSub) liveSub.textContent = money(t.subtotal);
  if (liveShip) liveShip.textContent = t.shipping === 0 && t.subtotal > 0 ? "免運" : money(t.shipping || SHIPPING_FEE);
  if (liveTotal) liveTotal.textContent = money(t.total);

  const fill = $("#ship-bar-fill");
  const text = $("#ship-progress-text");
  const pct = Math.min(100, Math.round((t.subtotal / FREE_SHIPPING_AT) * 100));
  if (fill) fill.style.width = pct + "%";
  if (text) {
    if (!t.items.length) {
      text.textContent = `商品金額滿 ${money(FREE_SHIPPING_AT)} 免運。`;
    } else if (t.free) {
      text.textContent = `已達免運門檻（滿 ${money(FREE_SHIPPING_AT)}）。`;
    } else {
      text.textContent = `再購 ${money(t.remain)} 即可免運（門檻 ${money(FREE_SHIPPING_AT)}）。`;
    }
  }

  const go = $("#go-checkout");
  if (go) go.setAttribute("aria-disabled", t.items.length ? "false" : "true");

  $$(".plan-card").forEach((card) => {
    const id = card.dataset.plan;
    const qty = state.cart[id] || 0;
    card.classList.toggle("in-cart", qty > 0);
    const note = card.querySelector("[data-in-cart-note]");
    if (note) {
      note.hidden = qty < 1;
      const plan = planById(id);
      note.textContent = qty > 0 ? `已在購物車 × ${qty} ${isBulk(plan) ? "錠" : "組"}` : "";
    }
  });

  const display = $("#selected-plan-display");
  if (display) {
    if (t.items.length) {
      display.classList.add("filled");
      const discountBit = (t.couponDiscount ? `　折抵 −${money(t.couponDiscount)}` : "") +
        (t.referralDiscount ? `　推薦 9 折 −${money(t.referralDiscount)}（預估）` : "");
      display.innerHTML = t.items
        .map((it) => lineLabel(it))
        .join("<br>") + `<br>小計 ${money(t.subtotal)}${discountBit}　運費 ${t.shipping ? money(t.shipping) : "免運"}　合計 ${money(t.total)}`;
    } else {
      display.classList.remove("filled");
      display.textContent = "請先將方案加入購物車";
    }
  }

  const mini = $("#form-summary");
  if (mini) mini.innerHTML = t.items.length ? cartSummaryHtml(t) : "";
}

/* ========== 表單 ========== */
function fieldValues() {
  return {
    name: $("#name").value.trim(),
    phone: normalizePhone($("#phone").value),
    lineId: $("#lineId").value.trim(),
    store: $("#store").value.trim(),
    notes: $("#notes").value.trim(),
    ageOk: $("#age-confirm").checked,
  };
}

function showError(id, on) {
  const el = document.getElementById(id);
  if (el) el.hidden = !on;
}

function validate() {
  const v = fieldValues();
  let ok = true;

  if (!cartItems().length) {
    ok = false;
    $("#selected-plan-display").scrollIntoView({ behavior: "smooth", block: "center" });
    alert("請先將方案加入購物車。");
    return false;
  }
  if (v.name.length < 2) {
    ok = false;
    $("#name").classList.add("invalid");
  } else {
    $("#name").classList.remove("invalid");
  }

  const phoneOk = isTaiwanMobile(v.phone);
  $("#phone").classList.toggle("invalid", !phoneOk);
  showError("phone-error", !phoneOk);
  if (!phoneOk) ok = false;

  const storeOk = v.store.length >= 2;
  $("#store").classList.toggle("invalid", !storeOk);
  showError("store-error", !storeOk);
  if (!storeOk) ok = false;

  showError("age-error", !v.ageOk);
  if (!v.ageOk) ok = false;

  const refCode = readReferralCode();
  const refOk = !refCode || REFERRAL_CODE_RE.test(refCode);
  const refEl = $("#referral-code");
  if (refEl) refEl.classList.toggle("invalid", !refOk);
  showError("referral-error", !refOk);
  if (!refOk) ok = false;

  const t = totals();
  const form = readCouponForm();
  const codeEl = $("#coupon-code");
  const fbEl = $("#coupon-feedback");
  if (t.couponAllowed && discountChoice() === "coupon") {
    const codeOk = isCouponCode(form.code);
    const fbOk = form.feedback.length >= COUPON_FEEDBACK_MIN && form.feedback.length <= COUPON_FEEDBACK_MAX;
    if (codeEl) codeEl.classList.toggle("invalid", !codeOk);
    if (fbEl) fbEl.classList.toggle("invalid", !fbOk);
    showError("coupon-code-error", !codeOk);
    showError("coupon-feedback-error", !fbOk);
    if (!codeOk || !fbOk) ok = false;
  } else {
    if (codeEl) codeEl.classList.remove("invalid");
    if (fbEl) fbEl.classList.remove("invalid");
    showError("coupon-code-error", false);
    showError("coupon-feedback-error", false);
  }

  return ok;
}

function buildOrder() {
  const t = totals();
  const v = fieldValues();
  const now = new Date();
  const stamp = now.toISOString().slice(2, 10).replace(/-/g, ""); // e.g. 261121
  const id = "DY" + stamp + "-" + String(Math.floor(100 + Math.random() * 900));
  return {
    orderId: id,
    createdAt: now.toISOString(),
    product: "大又持久錠",
    items: t.items,
    tabletTotal: t.tabletTotal,
    subtotal: t.subtotal,
    shippingFee: t.shipping,
    shippingLabel: t.shipping === 0 ? "免運" : money(t.shipping),
    shippingMethod: "7-11 賣貨便",
    freeShippingThreshold: FREE_SHIPPING_AT,
    discount: t.discount,
    couponDiscount: t.couponDiscount,
    referralDiscount: t.referralDiscount,
    referralCode: t.referralCode,
    referralConfirmed: false,
    referralPending: false,
    myReferralCode: "",
    couponCode: t.couponApplied ? t.couponCode : "",
    couponFeedback: t.couponApplied ? t.couponFeedback : "",
    publishConsent: t.couponApplied ? !!t.publishConsent : false,
    total: t.total,
    customer: {
      name: v.name,
      phone: v.phone,
      lineId: v.lineId || "",
      store: v.store,
      notes: v.notes || "",
    },
  };
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function orderSummaryHtml(order, opts) {
  opts = opts || {};
  const thankYou = !!opts.thankYou;
  const c = order.customer;
  const itemRows = (order.items || []).map((it) =>
    it.bulk
      ? ["批量", `× ${it.tabletTotal} 錠　${money(it.subtotal)}`]
      : [it.planName, `× ${it.quantity} 組（共 ${it.tabletTotal} 錠）　${money(it.subtotal)}`]
  );
  const rows = [
    ["訂單編號", order.orderId],
    ["商品", order.product],
    ...itemRows,
    ["商品小計", `${money(order.subtotal)}（共 ${order.tabletTotal} 錠）`],
  ];
  if (order.couponDiscount) {
    rows.push(["首購折抵券", "−" + money(order.couponDiscount) + "（" + escapeHtml(order.couponCode || "") + "，待客服核對）"]);
  }
  if (order.referralDiscount) {
    rows.push(["推薦碼 9 折", "−" + money(order.referralDiscount) + (order.referralConfirmed ? "" : "（預估，以系統確認為準）")]);
  } else if (order.referralPending) {
    rows.push(["推薦碼 9 折", "待客服確認後調整"]);
  }
  if (order.referralCode) {
    rows.push(["輸入推薦碼", escapeHtml(order.referralCode)]);
  }
  rows.push(
    ["配送", order.shippingMethod],
    ["運費", order.shippingFee ? money(order.shippingFee) : "免運"],
    ["應付金額", money(order.total), true]
  );
  if (order.couponDiscount) {
    rows.push(["使用心得", escapeHtml(order.couponFeedback || "")]);
    rows.push(["刊登同意", order.publishConsent ? "是" : "否"]);
  }
  rows.push(
    ["姓名", escapeHtml(c.name)],
    ["手機", c.phone],
    ["LINE ID", escapeHtml(c.lineId || "（未填）")],
    ["7-11 門市", escapeHtml(c.store)],
    ["備註", escapeHtml(c.notes || "（無）")]
  );
  const body = rows
    .map(
      function (row) {
        const k = row[0];
        const val = row[1];
        const total = row[2];
        return `<div class="confirm-row${total ? " total" : ""}"><span>${k}</span><span>${val}</span></div>`;
      }
    )
    .join("");
  const note = thankYou
    ? ""
    : `<p class="confirm-note">確認送出後，系統會自動通知賣家。</p>`;
  return body + note;
}

function formatOrderText(order) {
  const c = order.customer;
  const lines = (order.items || []).map((it) =>
    it.bulk
      ? `・批量 × ${it.tabletTotal} 錠　${money(it.subtotal)}`
      : `・${it.planName} × ${it.quantity} 組（共 ${it.tabletTotal} 錠）　${money(it.subtotal)}`
  );
  const out = [
    `訂單編號：${order.orderId}`,
    `商品：${order.product}`,
    "明細：",
    ...lines,
    `商品小計：${money(order.subtotal)}（共 ${order.tabletTotal} 錠）`,
  ];
  if (order.couponDiscount) {
    out.push("折抵券 " + order.couponCode + "（-NT$250，請核對是否為該客首購單且未使用過）");
  }
  if (order.referralDiscount) {
    out.push("推薦 9 折：-" + money(order.referralDiscount) + (order.referralConfirmed ? "" : "（預估）"));
  }
  if (order.referralCode) {
    out.push("推薦碼：" + order.referralCode + (order.referralPending ? "（待客服確認）" : ""));
  }
  out.push(
    `運費：${order.shippingFee ? money(order.shippingFee) : "免運"}`,
    `應付：${money(order.total)}`
  );
  if (order.myReferralCode) {
    out.push("我的推薦碼：" + order.myReferralCode);
  }
  if (order.couponDiscount) {
    out.push("使用心得：" + (order.couponFeedback || ""));
    out.push("刊登同意：" + (order.publishConsent ? "是" : "否"));
  }
  out.push(
    "若為首購→此單號即折抵券",
    `姓名：${c.name}`,
    `手機：${c.phone}`,
    `LINE ID：${c.lineId || "（未填）"}`,
    `7-11門市：${c.store}`,
    `備註：${c.notes || "（無）"}`
  );
  return out.join("\n");
}

function copyText(text) {
  const tryExec = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  };

  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => tryExec());
  }
  return Promise.resolve(tryExec());
}

function showToast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

async function copyOrderText() {
  const order = state.lastOrder || state.pendingOrder;
  if (!order) return false;
  const text = $("#order-text") ? $("#order-text").value || formatOrderText(order) : formatOrderText(order);
  const ok = await copyText(text);
  if (ok) {
    showToast("訂單已複製，請在 LINE 貼上傳送");
  } else {
    showToast("請手動選取下方文字後複製");
  }
  return ok;
}

async function sendOrderToLine() {
  await copyOrderText();
  window.open(LINE_OA_URL, "_blank", "noopener,noreferrer");
}


function openConfirm(order) {
  state.pendingOrder = order;
  $("#confirm-body").innerHTML = orderSummaryHtml(order);
  const modal = $("#confirm-modal");
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeConfirm() {
  $("#confirm-modal").hidden = true;
  document.body.classList.remove("modal-open");
  state.pendingOrder = null;
}

async function submitOrderToApi(order) {
  const payload = {
    items: (order.items || []).map((it) => ({ plan: it.planId, qty: it.quantity })),
    name: order.customer.name,
    phone: order.customer.phone,
    lineId: order.customer.lineId,
    store: order.customer.store,
    notes: order.customer.notes,
    website: $("#website") ? $("#website").value : "",
    couponCode: order.couponCode || "",
    couponFeedback: order.couponFeedback || "",
    publishConsent: order.publishConsent === true,
    referralCode: order.referralCode || "",
    discountChoice: order.couponCode ? "coupon" : "referral",
  };
  const res = await fetch(ORDER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    data = {};
  }
  return { http: res.status, ...data };
}

// 以伺服器回傳的金額與推薦結果為準
function applyServerResult(order, data) {
  if (!data) return;
  if (data.pricing && typeof data.pricing.total === "number") {
    order.couponDiscount = Number(data.pricing.couponDiscount) || 0;
    order.referralDiscount = Number(data.pricing.referralDiscount) || 0;
    order.discount = order.couponDiscount + order.referralDiscount;
    order.shippingFee = Number(data.pricing.shippingFee) || 0;
    order.total = data.pricing.total;
    order.referralConfirmed = true;
  }
  const ref = data.referral || {};
  order.referralPending = !!ref.pending && (!!order.referralCode || !!(state.referralLookup && state.referralLookup.result && state.referralLookup.result.bound));
  order.referralStatus = ref.status || "";
  order.myReferralCode = REFERRAL_CODE_RE.test(String(data.myReferralCode || "")) ? data.myReferralCode : "";
}

async function finalizeOrder(order) {
  try {
    const data = await submitOrderToApi(order);
    applyServerResult(order, data);
    if (data.ok && data.orderNo) {
      order.orderId = data.orderNo;
      showSuccess(order, { notified: true });
      return;
    }
    if (data.orderNo) order.orderId = data.orderNo;
    showSuccess(order, { notified: false, error: data.error || "notify_failed" });
  } catch (err) {
    showSuccess(order, { notified: false, error: "network" });
  }
}

function showSuccess(order, opts) {
  opts = opts || {};
  const notified = !!opts.notified;
  const error = opts.error || "";
  state.lastOrder = order;
  closeConfirm();
  $("#success-body").innerHTML = orderSummaryHtml(order, { thankYou: true });
  const box = $("#order-text");
  if (box) box.value = formatOrderText(order);

  const badge = $("#success-badge");
  const title = $("#success-title");
  const lead = $("#success-lead");
  const alert = $("#success-alert");
  const lineBtn = $("#send-to-line");

  if (notified) {
    if (badge) badge.textContent = "訂單已送出";
    if (title) title.innerHTML = "感謝你的訂購";
    if (lead) {
      lead.textContent = "賣家已自動收到這筆訂單通知（編號 " + order.orderId + "）。若要自行再傳一份，可複製下方內容傳到 LINE。";
    }
    if (alert) {
      alert.hidden = true;
      alert.textContent = "";
    }
    if (lineBtn) {
      lineBtn.className = "btn btn-ghost";
      lineBtn.textContent = "傳送訂單到 LINE（選用）";
    }
  } else {
    if (badge) badge.textContent = "自動通知未完成";
    if (title) title.innerHTML = "請傳至 LINE<br>完成下單";
    if (lead) {
      lead.textContent = "系統暫時無法自動通知賣家，請複製下方訂單傳到 LINE 客服完成下單。";
    }
    if (alert) {
      alert.hidden = false;
      alert.textContent = "自動通知失敗，請改用下方「傳送訂單到 LINE」完成下單。";
    }
    if (lineBtn) {
      lineBtn.className = "btn btn-line";
      lineBtn.textContent = "傳送訂單到 LINE 完成下單";
    }
  }

  const couponNote = $("#success-coupon-note");
  if (couponNote) {
    couponNote.hidden = false;
    couponNote.textContent = PROMO_TEXT + "。若這是您的第一次購買，請保留本訂單編號「" + order.orderId + "」，作為下次折抵券代碼。";
  }

  const refBox = $("#success-referral");
  if (refBox) {
    refBox.hidden = !order.myReferralCode;
    const codeEl = $("#success-referral-code");
    if (codeEl) codeEl.textContent = order.myReferralCode || "";
  }
  const refPending = $("#success-referral-pending");
  if (refPending) {
    const msgs = [];
    if (order.referralPending) {
      msgs.push("系統暫時無法確認推薦碼，本單先以原價顯示，9 折將由客服確認後調整。");
    } else if (order.referralCode && ["not_found", "own_code", "circular"].indexOf(order.referralStatus) >= 0) {
      msgs.push("推薦碼「" + order.referralCode + "」無法使用，本單以原價計算。如有疑問請洽 LINE 客服。");
    } else if (order.referralCode && order.referralStatus === "ignored_already_bound") {
      msgs.push("此手機已綁定其他推薦碼（推薦碼不可更換），本單沿用原推薦碼。");
    }
    if (!order.myReferralCode && (order.referralConfirmed || order.referralPending)) {
      msgs.push("你的專屬推薦碼將由 LINE 客服提供。分享你的推薦碼，朋友每次購買你都可得實付 10% 回饋金。" + REBATE_NOTE);
    }
    refPending.textContent = msgs.join(" ");
    refPending.hidden = !msgs.length;
  }

  $("#success-screen").hidden = false;
  document.body.classList.add("success-open");
  $("#bottom-bar").classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "instant" });
  const screen = $("#success-screen");
  if (screen) screen.scrollTop = 0;
  const back = $("#success-back");
  if (back) back.blur();
}

/* ========== 年齡門檻、底部列 ========== */

function setupCopyLineId() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy-line-id]");
    if (!btn) return;
    e.preventDefault();
    const id = btn.getAttribute("data-copy-line-id") || LINE_OA_ID;
    const ok = await copyText(id);
    showToast(ok ? "已複製 LINE ID：" + id : "請手動複製 LINE ID：" + id);
    if (ok) {
      const prev = btn.textContent;
      btn.textContent = "已複製";
      setTimeout(() => {
        btn.textContent = prev || "複製";
      }, 1600);
    }
  });
}

function setupAgeGate() {
  // Backup only. The inline script in index.html is the primary handler
  // so the gate still works if later init steps throw or app.js is stale.
  if (typeof window.__dyAgeOk === "function" && window.__dyAgeOk()) {
    if (typeof window.__dyEnterAge === "function") window.__dyEnterAge();
    return;
  }
  const gate = $("#age-gate");
  if (!gate || gate.hidden) return;
  document.body.classList.add("age-open");
  function enter(ev) {
    if (typeof window.__dyEnterAge === "function") {
      window.__dyEnterAge(ev);
      return;
    }
    if (ev && ev.preventDefault) ev.preventDefault();
    gate.hidden = true;
    gate.style.display = "none";
    document.body.classList.remove("age-open");
  }
  const enterBtn = $("#age-enter");
  const leaveBtn = $("#age-leave");
  if (enterBtn && enterBtn.getAttribute("data-age-bound") !== "1") {
    enterBtn.setAttribute("data-age-bound", "1");
    enterBtn.addEventListener("click", enter);
    enterBtn.addEventListener("touchend", enter);
  }
  if (leaveBtn && leaveBtn.getAttribute("data-age-bound") !== "1") {
    leaveBtn.setAttribute("data-age-bound", "1");
    leaveBtn.addEventListener("click", function () {
      document.body.innerHTML =
        '<main style="min-height:100vh;display:grid;place-items:center;background:#050b18;color:#c9a24a;font-family:sans-serif;text-align:center;padding:2rem;"><p>你已離開本頁。本產品僅供 18 歲以上成年人瀏覽與購買。</p></main>';
    });
  }
}

function setupStickyBar() {
  const bar = $("#bottom-bar");
  const footer = document.querySelector(".footer");
  if (!bar || !footer) return;
  const onScroll = () => {
    if (document.body.classList.contains("success-open") || document.body.classList.contains("age-open")) {
      bar.classList.add("hidden");
      return;
    }
    const rect = footer.getBoundingClientRect();
    bar.classList.toggle("hidden", rect.top < window.innerHeight);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/* ========== 啟動 ========== */
function runInitStep(name, fn) {
  try {
    fn();
  } catch (err) {
    if (typeof console !== "undefined" && console.error) {
      console.error("[init] " + name, err);
    }
  }
}

function init() {
  runInitStep("setupAgeGate", setupAgeGate);
  runInitStep("renderPlans", renderPlans);
  runInitStep("setupCartEvents", setupCartEvents);
  runInitStep("updateTotals", updateTotals);
  runInitStep("setupCopyLineId", setupCopyLineId);
  runInitStep("setupStickyBar", setupStickyBar);

  runInitStep("bindForm", function () {
  const couponCode = $("#coupon-code");
  const couponFeedback = $("#coupon-feedback");
  const couponPublish = $("#coupon-publish");
  function onCouponFormChange() {
    updateTotals();
  }
  if (couponCode) couponCode.addEventListener("input", onCouponFormChange);
  if (couponFeedback) couponFeedback.addEventListener("input", onCouponFormChange);
  if (couponPublish) couponPublish.addEventListener("change", onCouponFormChange);
  $$('input[name="discountChoice"]').forEach((el) => el.addEventListener("change", onCouponFormChange));
  const refInput = $("#referral-code");
  if (refInput) {
    refInput.addEventListener("input", () => {
      showError("referral-error", false);
      refInput.classList.remove("invalid");
      updateTotals();
      scheduleReferralLookup();
    });
    refInput.addEventListener("blur", () => {
      const code = readReferralCode();
      const bad = !!code && !REFERRAL_CODE_RE.test(code);
      refInput.classList.toggle("invalid", bad);
      showError("referral-error", bad);
    });
  }
  $("#phone").addEventListener("input", () => {
    updateTotals();
    scheduleReferralLookup();
  });
  const copyRef = $("#copy-referral-btn");
  if (copyRef) {
    copyRef.addEventListener("click", async () => {
      const code = ($("#success-referral-code") || {}).textContent || "";
      if (!code) return;
      const ok = await copyText(code);
      showToast(ok ? "推薦碼已複製，分享給朋友吧" : "請手動選取推薦碼");
    });
  }

  $("#phone").addEventListener("blur", () => {
    const ok = isTaiwanMobile($("#phone").value) || !$("#phone").value.trim();
    $("#phone").classList.toggle("invalid", !ok && $("#phone").value.trim());
    showError("phone-error", !ok && $("#phone").value.trim());
  });

  $("#order-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validate()) return;
    openConfirm(buildOrder());
  });

  $("#confirm-back").addEventListener("click", closeConfirm);
  $("#confirm-send").addEventListener("click", async () => {
    const order = state.pendingOrder;
    if (!order) return;
    const btn = $("#confirm-send");
    btn.disabled = true;
    btn.textContent = "送出中…";
    try {
      await finalizeOrder(order);
    } finally {
      btn.disabled = false;
      btn.textContent = "確認送出";
    }
  });

  $("#copy-order-btn").addEventListener("click", () => copyOrderText());
  $("#send-to-line").addEventListener("click", () => sendOrderToLine());

  $("#success-back").addEventListener("click", (e) => {
    e.preventDefault();
    $("#success-screen").hidden = true;
    document.body.classList.remove("success-open");
    $("#order-form").reset();
    state.cart = {};
    state.pendingOrder = null;
    state.lastOrder = null;
    state.referralLookup = null;
    $$(".plan-card").forEach((c) => {
      c.classList.remove("in-cart");
      const plan = planById(c.dataset.plan);
      writeCardQty(c, defaultQty(plan));
    });
    updateTotals();
    setupStickyBar();
    window.location.hash = "#top";
  });

  $("#confirm-modal").addEventListener("click", (e) => {
    if (e.target.id === "confirm-modal") closeConfirm();
  });
  });
}

function boot() {
  try {
    init();
  } catch (err) {
    if (typeof console !== "undefined" && console.error) {
      console.error("[init]", err);
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
