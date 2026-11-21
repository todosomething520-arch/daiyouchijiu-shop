/**
 * 大又持久錠 — 一頁式結帳
 * 送出訂單時 POST /api/order（由後端驗證、計價並通知賣家）。
 * 請勿在前端放置 LINE token。
 */

/* ========== 可調整設定 ========== */
const SHIPPING_FEE = 60; // 7-11 賣貨便運費（新台幣）；以後端重算為準
const FREE_SHIPPING_AT = 3000; // 商品金額滿此金額免運
const LINE_OA_URL = "https://line.me/R/ti/p/@997baoaw"; // 官方帳號加好友連結
const LINE_OA_ID = "@997baoaw"; // 官方帳號 ID（可搜尋）
const ORDER_API = "/api/order";

const PLANS = [
  { id: "p1", name: "1錠體驗", tablets: 1, price: 250, desc: "嘗鮮入門", unit: 250 },
  { id: "p3", name: "3錠組", tablets: 3, price: 700, desc: "輕量補充", unit: 233, save: 50 },
  { id: "p5", name: "5錠組", tablets: 5, price: 1100, desc: "熱銷推薦", unit: 220, save: 150, popular: true },
  { id: "p10", name: "10錠組", tablets: 10, price: 2000, desc: "最划算", unit: 200, save: 500, featured: true },
  { id: "p15", name: "15錠組", tablets: 15, price: 3000, desc: "一次買滿即免運", unit: 200, save: 750, freeShip: true, badge: "免運優惠" },
];

const QTY_MIN = 1;
const QTY_MAX = 20;

const state = {
  cart: {}, // planId -> qty
  pendingOrder: null,
  lastOrder: null,
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

function cartItems() {
  return PLANS.map((p) => {
    const qty = state.cart[p.id] || 0;
    if (qty < 1) return null;
    return {
      planId: p.id,
      planName: p.name,
      tabletsEach: p.tablets,
      quantity: qty,
      tabletTotal: p.tablets * qty,
      unitPrice: p.price,
      subtotal: p.price * qty,
    };
  }).filter(Boolean);
}

function clampQty(n) {
  const q = Math.floor(Number(n));
  if (!Number.isFinite(q)) return QTY_MIN;
  return Math.min(QTY_MAX, Math.max(QTY_MIN, q));
}

function totals() {
  const items = cartItems();
  const subtotal = items.reduce((s, it) => s + it.subtotal, 0);
  const tabletTotal = items.reduce((s, it) => s + it.tabletTotal, 0);
  const shipping = subtotal === 0 ? 0 : subtotal >= FREE_SHIPPING_AT ? 0 : SHIPPING_FEE;
  return {
    items,
    tabletTotal,
    subtotal,
    shipping,
    total: subtotal + shipping,
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
    const save = p.save ? `<div>省下 ${money(p.save)}</div>` : "<div>單錠原價</div>";
    const btnClass = p.featured || p.popular || p.freeShip ? "btn-primary" : "btn-ghost";
    const extras = [p.featured ? "featured" : "", p.freeShip ? "free-ship" : ""].filter(Boolean).join(" ");
    return `
      <article class="plan-card ${extras}" data-plan="${p.id}">
        ${badge}
        <h3>${p.name}</h3>
        <p class="plan-desc">${p.desc}</p>
        <div class="plan-price"><span class="currency">NT$</span> <span class="amount">${p.price.toLocaleString("zh-TW")}</span></div>
        <div class="plan-meta">
          <div>${p.tablets} 錠（每錠約 ${money(p.unit)}）</div>
          ${save}
        </div>
        <div class="plan-add">
          <div class="qty-control">
            <button type="button" data-add-delta="-1" aria-label="減少 ${p.name} 組數">−</button>
            <input type="number" class="plan-qty-input" min="1" max="20" value="1" inputmode="numeric" aria-label="${p.name} 加入組數">
            <button type="button" data-add-delta="1" aria-label="增加 ${p.name} 組數">+</button>
          </div>
          <button type="button" class="btn ${btnClass} add-to-cart">加入購物車</button>
        </div>
        <p class="in-cart-note" data-in-cart-note hidden></p>
      </article>`;
  }).join("");
}

function readCardQty(card) {
  const input = card.querySelector(".plan-qty-input");
  return clampQty(input ? input.value : 1);
}

function writeCardQty(card, qty) {
  const input = card.querySelector(".plan-qty-input");
  if (input && document.activeElement !== input) input.value = String(qty);
}

function addToCart(planId, qty) {
  const plan = planById(planId);
  if (!plan) return;
  const add = clampQty(qty);
  const current = state.cart[planId] || 0;
  if (current >= QTY_MAX) {
    showToast(`${plan.name} 最多可買 ${QTY_MAX} 組`);
    return;
  }
  const next = Math.min(QTY_MAX, current + add);
  state.cart[planId] = next;
  updateTotals();
  const card = document.querySelector(`.plan-card[data-plan="${planId}"]`);
  if (card) writeCardQty(card, 1);
  if (next < current + add) {
    showToast(`${plan.name} 已達 ${QTY_MAX} 組上限`);
  } else {
    showToast(`已加入購物車：${plan.name} × ${add} 組`);
  }
}

function setLineQty(planId, qty) {
  if (!planById(planId) || !state.cart[planId]) return;
  state.cart[planId] = clampQty(qty);
  updateTotals();
}

function removeLine(planId) {
  delete state.cart[planId];
  updateTotals();
}

function setupCartEvents() {
  const grid = $("#pricing-grid");
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".plan-card");
    if (!card) return;
    const planId = card.dataset.plan;
    if (e.target.closest("[data-add-delta]")) {
      const delta = Number(e.target.closest("[data-add-delta]").dataset.addDelta);
      writeCardQty(card, clampQty(readCardQty(card) + delta));
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
    writeCardQty(card, clampQty(input.value));
  });

  $("#cart-lines").addEventListener("click", (e) => {
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
  $("#cart-lines").addEventListener("change", (e) => {
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
      return `<div class="cart-line" data-plan="${it.planId}">
        <div class="cart-line-main">
          <div class="cart-line-info">
            <strong>${it.planName}</strong>
            <span>${it.planName} × ${it.quantity} 組（共 ${it.tabletTotal} 錠）</span>
          </div>
          <span class="cart-line-sub">${money(it.subtotal)}</span>
        </div>
        <div class="cart-line-actions">
          <div class="qty-control">
            <button type="button" data-cart-delta="-1" aria-label="減少 ${it.planName} 組數">−</button>
            <input type="number" min="1" max="20" value="${it.quantity}" inputmode="numeric" data-cart-qty="${it.planId}" aria-label="${it.planName} 組數">
            <button type="button" data-cart-delta="1" aria-label="增加 ${it.planName} 組數">+</button>
          </div>
          <button type="button" class="btn-remove" data-cart-remove="${it.planId}" aria-label="移除 ${it.planName}">移除</button>
        </div>
      </div>`;
    })
    .join("");
}

function cartSummaryHtml(t) {
  const itemRows = t.items
    .map((it) => `<div><span>${it.planName} × ${it.quantity} 組（共 ${it.tabletTotal} 錠）</span><span>${money(it.subtotal)}</span></div>`)
    .join("");
  return `<div class="live-lines">
      ${itemRows}
      <div><span>商品小計（共 ${t.tabletTotal} 錠）</span><span>${money(t.subtotal)}</span></div>
      <div><span>運費</span><span>${t.shipping ? money(t.shipping) : "免運"}</span></div>
      <div class="total"><span>應付金額</span><span>${money(t.total)}</span></div>
    </div>`;
}

function updateTotals() {
  const t = totals();
  renderCartLines(t.items);

  const pillLabel = t.items.length ? `商品小計（共 ${t.tabletTotal} 錠）` : "商品小計";
  $("#live-plan-label").textContent = pillLabel;
  $("#live-subtotal").textContent = money(t.subtotal);
  $("#live-shipping").textContent = t.shipping === 0 && t.subtotal > 0 ? "免運" : money(t.shipping || SHIPPING_FEE);
  $("#live-total").textContent = money(t.total);

  const fill = $("#ship-bar-fill");
  const text = $("#ship-progress-text");
  const pct = Math.min(100, Math.round((t.subtotal / FREE_SHIPPING_AT) * 100));
  fill.style.width = pct + "%";
  if (!t.items.length) {
    text.textContent = `商品金額滿 ${money(FREE_SHIPPING_AT)} 免運。`;
  } else if (t.free) {
    text.textContent = `已達免運門檻（滿 ${money(FREE_SHIPPING_AT)}）。`;
  } else {
    text.textContent = `再購 ${money(t.remain)} 即可免運（門檻 ${money(FREE_SHIPPING_AT)}）。`;
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
      note.textContent = qty > 0 ? `已在購物車 × ${qty} 組` : "";
    }
  });

  const display = $("#selected-plan-display");
  if (t.items.length) {
    display.classList.add("filled");
    display.innerHTML = t.items
      .map((it) => `${it.planName} × ${it.quantity} 組（共 ${it.tabletTotal} 錠）`)
      .join("<br>") + `<br>小計 ${money(t.subtotal)}　運費 ${t.shipping ? money(t.shipping) : "免運"}　合計 ${money(t.total)}`;
  } else {
    display.classList.remove("filled");
    display.textContent = "請先將方案加入購物車";
  }

  const mini = $("#form-summary");
  mini.innerHTML = t.items.length ? cartSummaryHtml(t) : "";
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

function orderSummaryHtml(order, { thankYou = false } = {}) {
  const c = order.customer;
  const itemRows = (order.items || []).map((it) => [
    it.planName,
    `× ${it.quantity} 組（共 ${it.tabletTotal} 錠）　${money(it.subtotal)}`,
  ]);
  const rows = [
    ["訂單編號", order.orderId],
    ["商品", order.product],
    ...itemRows,
    ["商品小計", `${money(order.subtotal)}（共 ${order.tabletTotal} 錠）`],
    ["配送", order.shippingMethod],
    ["運費", order.shippingFee ? money(order.shippingFee) : "免運"],
    ["應付金額", money(order.total), true],
    ["姓名", c.name],
    ["手機", c.phone],
    ["LINE ID", c.lineId || "（未填）"],
    ["7-11 門市", c.store],
    ["備註", c.notes || "（無）"],
  ];
  const body = rows
    .map(
      ([k, val, total]) =>
        `<div class="confirm-row${total ? " total" : ""}"><span>${k}</span><span>${val}</span></div>`
    )
    .join("");
  const note = thankYou
    ? ""
    : `<p class="confirm-note">確認送出後，系統會自動通知賣家。</p>`;
  return body + note;
}

function formatOrderText(order) {
  const c = order.customer;
  const lines = (order.items || []).map(
    (it) => `・${it.planName} × ${it.quantity} 組（共 ${it.tabletTotal} 錠）　${money(it.subtotal)}`
  );
  return [
    `訂單編號：${order.orderId}`,
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

async function finalizeOrder(order) {
  try {
    const data = await submitOrderToApi(order);
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

function showSuccess(order, { notified = false, error = "" } = {}) {
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
  const gate = $("#age-gate");
  document.body.classList.add("age-open");
  $("#age-enter").addEventListener("click", () => {
    gate.hidden = true;
    document.body.classList.remove("age-open");
  });
  $("#age-leave").addEventListener("click", () => {
    document.body.innerHTML =
      '<main style="min-height:100vh;display:grid;place-items:center;background:#050b18;color:#c9a24a;font-family:sans-serif;text-align:center;padding:2rem;"><p>你已離開本頁。本產品僅供 18 歲以上成年人瀏覽與購買。</p></main>';
  });
}

function setupStickyBar() {
  const bar = $("#bottom-bar");
  const footer = document.querySelector(".footer");
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
function init() {
  renderPlans();
  setupCartEvents();
  updateTotals();
  setupAgeGate();
  setupCopyLineId();
  setupStickyBar();

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
    $$(".plan-card").forEach((c) => {
      c.classList.remove("in-cart");
      const input = c.querySelector(".plan-qty-input");
      if (input) input.value = "1";
    });
    updateTotals();
    setupStickyBar();
    window.location.hash = "#top";
  });

  $("#confirm-modal").addEventListener("click", (e) => {
    if (e.target.id === "confirm-modal") closeConfirm();
  });
}

document.addEventListener("DOMContentLoaded", init);
