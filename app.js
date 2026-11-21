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
      display.innerHTML = t.items
        .map((it) => lineLabel(it))
        .join("<br>") + `<br>小計 ${money(t.subtotal)}　運費 ${t.shipping ? money(t.shipping) : "免運"}　合計 ${money(t.total)}`;
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
