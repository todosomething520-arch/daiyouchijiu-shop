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
];

const state = {
  planId: null,
  qty: 1,
  pendingOrder: null,
  lastOrder: null,
};

/* ========== 工具 ========== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function money(n) {
  return "NT$" + Math.round(n).toLocaleString("zh-TW");
}

function currentPlan() {
  return PLANS.find((p) => p.id === state.planId) || null;
}

function totals() {
  const plan = currentPlan();
  const subtotal = plan ? plan.price * state.qty : 0;
  const shipping = subtotal === 0 ? 0 : subtotal >= FREE_SHIPPING_AT ? 0 : SHIPPING_FEE;
  return {
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

/* ========== 方案與即時金額 ========== */
function renderPlans() {
  const grid = $("#pricing-grid");
  grid.innerHTML = PLANS.map((p) => {
    const badge = p.featured
      ? '<div class="plan-badge">最划算</div>'
      : p.popular
      ? '<div class="plan-badge">熱銷推薦</div>'
      : "";
    const save = p.save ? `<div>省下 ${money(p.save)}</div>` : "<div>單錠原價</div>";
    return `
      <article class="plan-card ${p.featured ? "featured" : ""}" data-plan="${p.id}" tabindex="0" role="button" aria-pressed="false">
        ${badge}
        <h3>${p.name}</h3>
        <p class="plan-desc">${p.desc}</p>
        <div class="plan-price"><span class="currency">NT$</span> <span class="amount">${p.price.toLocaleString("zh-TW")}</span></div>
        <div class="plan-meta">
          <div>${p.tablets} 錠（每錠約 ${money(p.unit)}）</div>
          ${save}
        </div>
        <button type="button" class="btn ${p.featured || p.popular ? "btn-primary" : "btn-ghost"} select-plan">選擇此方案</button>
      </article>`;
  }).join("");

  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".plan-card");
    if (card) selectPlan(card.dataset.plan);
  });
  grid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".plan-card");
    if (!card) return;
    e.preventDefault();
    selectPlan(card.dataset.plan);
  });
}

function selectPlan(id) {
  state.planId = id;
  if (state.qty < 1) state.qty = 1;
  $$(".plan-card").forEach((card) => {
    const on = card.dataset.plan === id;
    card.classList.toggle("selected", on);
    card.setAttribute("aria-pressed", on ? "true" : "false");
  });
  $("#order-live").hidden = false;
  $("#qty-input").value = String(state.qty);
  updateTotals();
}

function updateTotals() {
  const plan = currentPlan();
  const t = totals();
  const qtyInput = $("#qty-input");
  if (document.activeElement !== qtyInput) qtyInput.value = String(state.qty);

  const label = plan
    ? `${plan.name} × ${state.qty} 組（共 ${plan.tablets * state.qty} 錠）`
    : "尚未選擇";
  $("#live-plan-label").textContent = label;
  $("#live-subtotal").textContent = money(t.subtotal);
  $("#live-shipping").textContent = t.shipping === 0 && t.subtotal > 0 ? "免運" : money(t.shipping || SHIPPING_FEE);
  $("#live-total").textContent = money(t.total);

  const fill = $("#ship-bar-fill");
  const text = $("#ship-progress-text");
  const pct = Math.min(100, Math.round((t.subtotal / FREE_SHIPPING_AT) * 100));
  fill.style.width = pct + "%";
  if (!plan) {
    text.textContent = `商品金額滿 ${money(FREE_SHIPPING_AT)} 免運。`;
  } else if (t.free) {
    text.textContent = `已達免運門檻（滿 ${money(FREE_SHIPPING_AT)}）。`;
  } else {
    text.textContent = `再購 ${money(t.remain)} 即可免運（門檻 ${money(FREE_SHIPPING_AT)}）。`;
  }

  const display = $("#selected-plan-display");
  if (plan) {
    display.classList.add("filled");
    display.textContent = `${label}　小計 ${money(t.subtotal)}　運費 ${t.shipping ? money(t.shipping) : "免運"}　合計 ${money(t.total)}`;
  } else {
    display.classList.remove("filled");
    display.textContent = "請先從上方選擇方案";
  }

  const mini = $("#form-summary");
  if (plan) {
    mini.innerHTML = `<div class="live-lines">
      <div><span>${label}</span><span>${money(t.subtotal)}</span></div>
      <div><span>運費</span><span>${t.shipping ? money(t.shipping) : "免運"}</span></div>
      <div class="total"><span>應付金額</span><span>${money(t.total)}</span></div>
    </div>`;
  } else {
    mini.innerHTML = "";
  }
}

function setQty(n) {
  const next = Math.min(20, Math.max(1, Number(n) || 1));
  state.qty = next;
  updateTotals();
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

  if (!currentPlan()) {
    ok = false;
    $("#selected-plan-display").scrollIntoView({ behavior: "smooth", block: "center" });
    alert("請先選擇方案。");
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
  const plan = currentPlan();
  const t = totals();
  const v = fieldValues();
  const now = new Date();
  const stamp = now.toISOString().slice(2, 10).replace(/-/g, ""); // e.g. 261121
  const id = "DY" + stamp + "-" + String(Math.floor(100 + Math.random() * 900));
  return {
    orderId: id,
    createdAt: now.toISOString(),
    product: "大又持久錠",
    planId: plan.id,
    planName: plan.name,
    tabletsEach: plan.tablets,
    quantity: state.qty,
    tabletTotal: plan.tablets * state.qty,
    unitPrice: plan.price,
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
  const rows = [
    ["訂單編號", order.orderId],
    ["商品", `${order.product}／${order.planName}`],
    ["組數", `${order.quantity} 組（共 ${order.tabletTotal} 錠）`],
    ["商品金額", money(order.subtotal)],
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
  return [
    `訂單編號：${order.orderId}`,
    `方案：${order.product}／${order.planName}`,
    `組數：${order.quantity} 組（共 ${order.tabletTotal} 錠）`,
    `金額：${money(order.subtotal)}`,
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
    planId: order.planId,
    quantity: order.quantity,
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
  updateTotals();
  setupAgeGate();
  setupCopyLineId();
  setupStickyBar();

  $("#qty-minus").addEventListener("click", () => setQty(state.qty - 1));
  $("#qty-plus").addEventListener("click", () => setQty(state.qty + 1));
  $("#qty-input").addEventListener("change", (e) => setQty(e.target.value));
  $("#qty-input").addEventListener("input", (e) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n) && n >= 1) {
      state.qty = Math.min(20, Math.floor(n));
      updateTotals();
    }
  });

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
    state.planId = null;
    state.qty = 1;
    state.pendingOrder = null;
    state.lastOrder = null;
    $$(".plan-card").forEach((c) => {
      c.classList.remove("selected");
      c.setAttribute("aria-pressed", "false");
    });
    $("#order-live").hidden = true;
    updateTotals();
    setupStickyBar();
    window.location.hash = "#top";
  });

  $("#confirm-modal").addEventListener("click", (e) => {
    if (e.target.id === "confirm-modal") closeConfirm();
  });
}

document.addEventListener("DOMContentLoaded", init);
