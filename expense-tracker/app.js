/* =========================================================
   拾光記帳 · Healing Ledger — 前端互動邏輯（V1 原型）

   儲存策略：
   - 一律先寫入 localStorage（單機也能用，離線不中斷）。
   - 若執行環境提供 Claude Artifact 的 `artifact` capability
     （也就是以 Claude Artifact 網址開啟時），額外把整份頁面
     連同最新資料發布出去，達成跨裝置同步 —— 每個打開同一個
     Artifact 連結的裝置，看到的都會是最後一次發布的版本。
   - 在一般網頁（GitHub Pages）或本機檔案開啟時沒有這個
     capability，會自動略過雲端同步，僅維持單機 localStorage。
   ========================================================= */

(function () {
  "use strict";

  /* ---------------- 分類設定 ---------------- */
  const CATEGORIES = [
    { key: "吃飯",        color: "var(--c-food)",    keywords: ["早餐","午餐","晚餐","消夜","宵夜","咖啡","飲料","便當","餐廳","小吃","火鍋","燒烤","飯","麵","吃","茶","星巴克","超商","熱炒","早午餐","甜點","蛋糕","滷味","食材","買菜","生鮮","菜市場","果菜","蔬菜","水果","海鮮","豬肉","雞肉","牛肉","市場"] },
    { key: "娛樂",        color: "var(--c-fun)",     keywords: ["電影","KTV","唱歌","展覽","演唱會","旅遊","酒吧","門票","樂園","遊戲","娛樂","景點","飯店","住宿","機票"] },
    { key: "生活用品",     color: "var(--c-daily)",   keywords: ["衛生紙","清潔","日用品","超市","全聯","家樂福","寶雅","洗髮精","牙膏","衛生棉","生活","雜貨","文具"] },
    { key: "油錢/停車費",  color: "var(--c-fuel)",    keywords: ["加油","停車","油錢","停車費","高速公路","ETC","過路費","機車保養","汽車保養","洗車"] },
    { key: "會員費用",     color: "var(--c-member)",  keywords: ["訂閱","會員","netflix","spotify","健身房","月費","年費","disney","youtube"] },
    { key: "服飾",        color: "var(--c-clothes)", keywords: ["衣服","鞋子","包包","飾品","服飾","買衣","uniqlo","zara","gu","outlet","帽子","襪子"] },
    { key: "奢侈品",       color: "var(--c-luxury)",  keywords: ["精品","名牌","珠寶","手錶","lv","gucci","chanel","奢侈","名錶","限量"] }
  ];
  const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));
  const FALLBACK_CATEGORY = "生活用品";

  function categorize(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    for (const cat of CATEGORIES) {
      if (cat.keywords.some(k => t.includes(k.toLowerCase()))) return cat.key;
    }
    return FALLBACK_CATEGORY;
  }

  /* ---------------- 狀態 / 儲存 ---------------- */
  const STORAGE_KEY = "healing-ledger-v1";

  function seedState() {
    const now = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const thisMonth = (day) => iso(new Date(now.getFullYear(), now.getMonth(), day));

    return {
      updatedAt: Date.now(),
      accounts: [
        { id: "a1", name: "國泰銀行", balance: 52340 },
        { id: "a2", name: "台北富邦", balance: 18000 },
        { id: "a3", name: "郵局帳戶", balance: 9000 }
      ],
      cards: [
        { id: "c1", name: "國泰 CUBE 卡", unbilled: 4200, billingDay: 20, dueDay: 5 },
        { id: "c2", name: "台新 Richart 卡", unbilled: 1500, billingDay: 15, dueDay: 3 }
      ],
      recurring: [
        { id: "r1", name: "房租", amount: 12000, done: false },
        { id: "r2", name: "電費", amount: 1200, done: false },
        { id: "r3", name: "網路費", amount: 799, done: true },
        { id: "r4", name: "健身房會員", amount: 1000, done: false }
      ],
      recurringResetDay: 1,
      recurringLastResetMonth: now.getFullYear() + "-" + (now.getMonth() + 1),
      transactions: [
        { id: "t1", date: thisMonth(3),  item: "午餐便當",   amount: 120,  category: "吃飯",       paymentId: "cash" },
        { id: "t2", date: thisMonth(5),  item: "全聯日用品", amount: 640,  category: "生活用品",   paymentId: "a1" },
        { id: "t3", date: thisMonth(8),  item: "加油",       amount: 800,  category: "油錢/停車費", paymentId: "c1" },
        { id: "t4", date: thisMonth(10), item: "看電影",     amount: 320,  category: "娛樂",       paymentId: "c1" },
        { id: "t5", date: thisMonth(14), item: "Netflix 訂閱", amount: 390, category: "會員費用",  paymentId: "a2" },
        { id: "t6", date: thisMonth(18), item: "UNIQLO 買衣", amount: 1290, category: "服飾",      paymentId: "c2" }
      ]
    };
  }

  function readJson(str) {
    try { return JSON.parse(str); } catch (e) { return null; }
  }

  // 從頁面內嵌的 <script id="app-state"> 讀出「目前這份文件」記錄的資料
  // （Claude Artifact 每次發布都會把最新資料連同整份頁面一起存起來，
  //  所以其他裝置打開同一個網址時，這個內嵌資料就是最新的雲端版本）
  function readEmbeddedState() {
    const el = document.getElementById("app-state");
    if (!el || !el.textContent.trim()) return null;
    return readJson(el.textContent);
  }

  function readLocalState() {
    return readJson(localStorage.getItem(STORAGE_KEY) || "");
  }

  // 本機與內嵌（雲端）兩份資料都存在時，用 updatedAt 挑比較新的那份
  function loadState() {
    const embedded = readEmbeddedState();
    const local = readLocalState();
    let chosen;
    if (embedded && local) {
      chosen = (local.updatedAt || 0) >= (embedded.updatedAt || 0) ? local : embedded;
    } else {
      chosen = embedded || local || seedState();
    }
    if (!chosen.updatedAt) chosen.updatedAt = Date.now();
    return chosen;
  }

  function persistLocal(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* 儲存空間不足等情況靜默略過 */ }
  }

  function embedStateInDom(s) {
    let el = document.getElementById("app-state");
    if (!el) {
      el = document.createElement("script");
      el.type = "application/json";
      el.id = "app-state";
      document.body.insertBefore(el, document.body.firstChild);
    }
    el.textContent = JSON.stringify(s);
  }

  // Claude Artifact 的 `artifact` capability：可用時，儲存動作會把整份
  // 頁面連同最新資料一起發布，所有打開同一連結的裝置都會同步到這份。
  let cloudApi = null;
  let cloudReady = false;

  async function initCloud() {
    if (typeof window.claude === "undefined" || typeof window.claude.use !== "function") {
      cloudReady = true;
      updateSyncBadge();
      return;
    }
    try {
      cloudApi = await window.claude.use("artifact");
    } catch (e) {
      cloudApi = null;
    }
    cloudReady = true;
    updateSyncBadge();
  }

  function updateSyncBadge() {
    const badge = document.getElementById("syncBadge");
    if (!badge) return;
    if (cloudApi) {
      badge.textContent = "☁ 雲端同步中";
      badge.classList.add("on");
    } else {
      badge.textContent = "";
      badge.classList.remove("on");
    }
  }

  // 所有會改變資料的操作，最後都呼叫這個函式：
  // 1) 先寫本機 localStorage（永遠成功，離線也能用）
  // 2) 更新頁面內嵌的 app-state（讓「發布出去的這份文件」帶有最新資料）
  // 3) 若有雲端 capability，把整份文件發布出去，其他裝置打開同一連結
  //    就會看到最新資料。發布衝突是正常情況（例如兩台裝置差不多時間
  //    各自存了一筆），不重試 —— 之後 Claude 平台會把畫面同步回最終版本。
  async function saveState(s) {
    s.updatedAt = Date.now();
    persistLocal(s);
    embedStateInDom(s);
    if (cloudApi) {
      try {
        const html = "<!doctype html>\n" + document.documentElement.outerHTML;
        await cloudApi.publish(html);
      } catch (e) {
        /* 衝突或離線：不重試，交給平台把畫面同步回最新版本 */
      }
    }
  }

  let state = loadState();
  persistLocal(state);

  /* ---------------- 每月固定繳費自動重置 ----------------
     只在載入當下判斷、只更動本機資料；真正發布給雲端的動作
     會等到使用者下一次實際操作（新增/刪除/勾選…）時才一併送出，
     符合「只在使用者互動後才發布」的原則。 */
  function maybeResetRecurring() {
    const now = new Date();
    const currentMonthKey = now.getFullYear() + "-" + (now.getMonth() + 1);
    const resetDay = state.recurringResetDay || 1;
    if (state.recurringLastResetMonth !== currentMonthKey && now.getDate() >= resetDay) {
      state.recurring.forEach(r => (r.done = false));
      state.recurringLastResetMonth = currentMonthKey;
      persistLocal(state);
    }
  }
  maybeResetRecurring();

  /* ---------------- 共用工具 ---------------- */
  const fmt = new Intl.NumberFormat("zh-Hant-TW");
  const money = (n) => "$" + fmt.format(Math.round(n));
  const uid = () => Math.random().toString(36).slice(2, 9);

  function paymentLabel(id) {
    if (id === "cash") return "現金";
    const acc = state.accounts.find(a => a.id === id);
    if (acc) return acc.name;
    const card = state.cards.find(c => c.id === id);
    if (card) return card.name;
    return "未知帳戶";
  }

  function renderPaymentOptions(selectEl) {
    let html = `<option value="cash">現金</option>`;
    if (state.accounts.length) {
      html += `<optgroup label="銀行帳戶">`;
      html += state.accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join("");
      html += `</optgroup>`;
    }
    if (state.cards.length) {
      html += `<optgroup label="信用卡">`;
      html += state.cards.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
      html += `</optgroup>`;
    }
    selectEl.innerHTML = html;
  }

  /* ================= 首頁：快速記帳 ================= */
  const itemInput = document.getElementById("itemInput");
  const amountInput = document.getElementById("amountInput");
  const paymentSelect = document.getElementById("paymentSelect");
  const catDot = document.getElementById("catDot");
  const catLabel = document.getElementById("catLabel");
  const addBtn = document.getElementById("addBtn");
  const formHint = document.getElementById("formHint");

  itemInput.addEventListener("input", () => {
    const guess = categorize(itemInput.value.trim());
    if (guess) {
      catDot.style.background = CATEGORY_MAP[guess].color;
      catLabel.textContent = `自動分類為「${guess}」`;
      catLabel.style.color = "var(--text-primary)";
    } else {
      catDot.style.background = "var(--text-faint)";
      catLabel.textContent = "輸入後將自動判斷分類";
      catLabel.style.color = "var(--text-secondary)";
    }
  });

  addBtn.addEventListener("click", () => {
    const item = itemInput.value.trim();
    const amount = parseFloat(amountInput.value);
    const paymentId = paymentSelect.value;

    if (!item) { showHint("請輸入花費項目"); return; }
    if (!amount || amount <= 0) { showHint("請輸入有效金額"); return; }

    const category = categorize(item);

    const tx = {
      id: uid(),
      date: new Date().toISOString().slice(0, 10),
      item, amount, category, paymentId
    };
    state.transactions.unshift(tx);
    applyPaymentDelta(paymentId, amount, +1);

    itemInput.value = "";
    amountInput.value = "";
    catDot.style.background = "var(--text-faint)";
    catLabel.textContent = "輸入後將自動判斷分類";
    showHint(`已記錄「${item}」，歸類於${category} ✓`);

    renderHome();
    renderChart();
    renderAccounts();
    renderCards();

    saveState(state);
  });

  function showHint(msg) {
    formHint.textContent = msg;
    clearTimeout(showHint._t);
    showHint._t = setTimeout(() => (formHint.textContent = ""), 2600);
  }

  function applyPaymentDelta(paymentId, amount, sign) {
    // sign +1 = 消費發生（帳戶減少 / 卡片未出帳增加）；-1 = 刪除紀錄時還原
    if (paymentId === "cash") return;
    const acc = state.accounts.find(a => a.id === paymentId);
    if (acc) { acc.balance -= amount * sign; return; }
    const card = state.cards.find(c => c.id === paymentId);
    if (card) { card.unbilled += amount * sign; }
  }

  function deleteTransaction(id) {
    const idx = state.transactions.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tx = state.transactions[idx];
    applyPaymentDelta(tx.paymentId, tx.amount, -1);
    state.transactions.splice(idx, 1);
    renderHome(); renderChart(); renderAccounts(); renderCards();
    saveState(state);
  }

  function monthTotalSpend(offset = 0) {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const y = target.getFullYear(), m = target.getMonth();
    return state.transactions.filter(t => {
      const d = new Date(t.date);
      return d.getFullYear() === y && d.getMonth() === m;
    });
  }

  function renderHome() {
    const thisMonthTx = monthTotalSpend(0);
    const total = thisMonthTx.reduce((s, t) => s + t.amount, 0);
    document.getElementById("monthTotal").textContent = money(total);

    const accTotal = state.accounts.reduce((s, a) => s + a.balance, 0);
    document.getElementById("totalBalance").textContent = money(accTotal);

    renderPaymentOptions(paymentSelect);

    const list = document.getElementById("recentList");
    const empty = document.getElementById("recentEmpty");
    const recent = state.transactions.slice(0, 8);
    empty.style.display = recent.length ? "none" : "block";
    list.innerHTML = recent.map(t => {
      const cat = CATEGORY_MAP[t.category] || { color: "var(--text-faint)" };
      return `
        <li class="list-item">
          <span class="item-dot" style="background:${cat.color}"></span>
          <div class="item-main">
            <div class="item-title">${escapeHtml(t.item)}</div>
            <div class="item-sub">${t.date} · ${t.category} · ${paymentLabel(t.paymentId)}</div>
          </div>
          <div class="item-amount">-${money(t.amount)}</div>
          <button class="item-delete" data-del="${t.id}" aria-label="刪除">✕</button>
        </li>`;
    }).join("");

    list.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", () => deleteTransaction(btn.getAttribute("data-del")));
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  /* ================= 圖表 ================= */
  let chartMonthOffset = 0;

  document.getElementById("prevMonth").addEventListener("click", () => { chartMonthOffset--; renderChart(); });
  document.getElementById("nextMonth").addEventListener("click", () => {
    if (chartMonthOffset < 0) chartMonthOffset++;
    renderChart();
  });

  function renderChart() {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + chartMonthOffset, 1);
    document.getElementById("chartMonthLabel").textContent =
      `${target.getFullYear()} 年 ${target.getMonth() + 1} 月`;

    const tx = monthTotalSpend(chartMonthOffset);
    const totals = {};
    tx.forEach(t => { totals[t.category] = (totals[t.category] || 0) + t.amount; });
    const total = Object.values(totals).reduce((a, b) => a + b, 0);

    const svg = document.getElementById("donutChart");
    const legend = document.getElementById("chartLegend");
    const emptyEl = document.getElementById("chartEmpty");
    document.getElementById("donutTotal").textContent = money(total);

    if (!total) {
      svg.innerHTML = `<circle cx="100" cy="100" r="80" fill="none" stroke="#E2D9CC" stroke-width="26"/>`;
      legend.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";

    const r = 80, cx = 100, cy = 100, circumference = 2 * Math.PI * r;
    let offset = 0;
    const rootStyles = getComputedStyle(document.documentElement);
    const resolveColor = (c) => c.startsWith("var(") ? rootStyles.getPropertyValue(c.slice(4, -1)).trim() : c;

    const entries = CATEGORIES
      .map(c => ({ key: c.key, color: c.color, value: totals[c.key] || 0 }))
      .filter(e => e.value > 0)
      .sort((a, b) => b.value - a.value);

    svg.innerHTML = entries.map(e => {
      const frac = e.value / total;
      const len = frac * circumference;
      const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${resolveColor(e.color)}" stroke-width="26"
        stroke-dasharray="${len} ${circumference - len}"
        stroke-dashoffset="${-offset}" />`;
      offset += len;
      return circle;
    }).join("");

    legend.innerHTML = entries.map(e => `
      <li>
        <span class="item-dot" style="background:${e.color}"></span>
        <span class="legend-name">${e.key}</span>
        <span class="legend-percent">${Math.round((e.value / total) * 100)}%</span>
        <span class="legend-amount">${money(e.value)}</span>
      </li>`).join("");
  }

  /* ================= 帳戶 ================= */
  function renderAccounts() {
    const list = document.getElementById("accountList");
    list.innerHTML = state.accounts.map(a => `
      <li class="list-item">
        <span class="item-dot" style="background:var(--c-fun)"></span>
        <div class="item-main">
          <div class="item-title">${escapeHtml(a.name)}</div>
          <div class="item-sub">銀行帳戶</div>
        </div>
        <div class="item-amount">${money(a.balance)}</div>
        <button class="item-delete" data-del-acc="${a.id}" aria-label="刪除">✕</button>
      </li>`).join("");

    list.querySelectorAll("[data-del-acc]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.accounts = state.accounts.filter(a => a.id !== btn.getAttribute("data-del-acc"));
        renderAccounts(); renderHome();
        saveState(state);
      });
    });

    document.getElementById("accountsTotal").textContent =
      money(state.accounts.reduce((s, a) => s + a.balance, 0));
  }

  document.getElementById("addAccountBtn").addEventListener("click", () => {
    openModal({
      title: "新增銀行帳戶",
      fields: [
        { key: "name", label: "帳戶名稱", type: "text", placeholder: "例如：中國信託" },
        { key: "balance", label: "目前餘額", type: "number", placeholder: "0" }
      ],
      onSave: (v) => {
        if (!v.name) return;
        state.accounts.push({ id: uid(), name: v.name, balance: parseFloat(v.balance) || 0 });
        renderAccounts(); renderHome();
      }
    });
  });

  /* ================= 信用卡 ================= */
  const CARD_THEMES = ["", "theme-1", "theme-2", "theme-3"];

  function nextDueInfo(card) {
    const now = new Date();
    let due = new Date(now.getFullYear(), now.getMonth(), card.dueDay);
    if (due < now) due = new Date(now.getFullYear(), now.getMonth() + 1, card.dueDay);
    const daysLeft = Math.ceil((due - now) / 86400000);
    let cls = "";
    if (daysLeft <= 3) cls = "urgent";
    else if (daysLeft <= 7) cls = "warn";
    return { due, daysLeft, cls };
  }

  function renderCards() {
    const list = document.getElementById("cardList");
    const empty = document.getElementById("cardsEmpty");
    empty.style.display = state.cards.length ? "none" : "block";

    list.innerHTML = state.cards.map((c, i) => {
      const { daysLeft, cls } = nextDueInfo(c);
      const badgeText = daysLeft <= 0 ? "已逾期" : `${daysLeft} 天後到期`;
      return `
        <li class="credit-card ${CARD_THEMES[i % CARD_THEMES.length]}">
          <div class="credit-card-top">
            <span class="credit-card-name">${escapeHtml(c.name)}</span>
            <button class="credit-card-delete" data-del-card="${c.id}" aria-label="刪除">✕</button>
          </div>
          <div class="credit-card-amount">
            <small>本期未出帳金額</small>
            ${money(c.unbilled)}
          </div>
          <div class="credit-card-bottom">
            <span>每月 ${c.billingDay} 號結帳 · ${c.dueDay} 號前繳款</span>
            <span class="due-badge ${cls}"><span class="due-dot"></span>${badgeText}</span>
          </div>
        </li>`;
    }).join("");

    list.querySelectorAll("[data-del-card]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.cards = state.cards.filter(c => c.id !== btn.getAttribute("data-del-card"));
        renderCards(); renderHome();
        saveState(state);
      });
    });
  }

  document.getElementById("addCardBtn").addEventListener("click", () => {
    openModal({
      title: "新增信用卡",
      fields: [
        { key: "name", label: "卡片名稱", type: "text", placeholder: "例如：玉山 Only 卡" },
        { key: "unbilled", label: "本期未出帳金額", type: "number", placeholder: "0" },
        { key: "billingDay", label: "結帳日（每月幾號）", type: "number", placeholder: "20" },
        { key: "dueDay", label: "繳款截止日（每月幾號）", type: "number", placeholder: "5" }
      ],
      onSave: (v) => {
        if (!v.name) return;
        state.cards.push({
          id: uid(),
          name: v.name,
          unbilled: parseFloat(v.unbilled) || 0,
          billingDay: Math.min(28, Math.max(1, parseInt(v.billingDay) || 20)),
          dueDay: Math.min(28, Math.max(1, parseInt(v.dueDay) || 5))
        });
        renderCards(); renderHome();
      }
    });
  });

  /* ================= 週期性繳費 ================= */
  const resetDayInput = document.getElementById("resetDayInput");
  resetDayInput.value = state.recurringResetDay;
  resetDayInput.addEventListener("change", () => {
    const v = Math.min(28, Math.max(1, parseInt(resetDayInput.value) || 1));
    state.recurringResetDay = v;
    resetDayInput.value = v;
    saveState(state);
  });

  function renderRecurring() {
    const list = document.getElementById("recurringList");
    const empty = document.getElementById("recurringEmpty");
    empty.style.display = state.recurring.length ? "none" : "block";

    list.innerHTML = state.recurring.map(r => `
      <li class="recurring-item">
        <button class="checkbox ${r.done ? "checked" : ""}" data-toggle="${r.id}" aria-label="標記完成">${r.done ? "✓" : ""}</button>
        <div class="recurring-main">
          <div class="recurring-name ${r.done ? "done" : ""}">${escapeHtml(r.name)}</div>
        </div>
        <div class="recurring-amount ${r.done ? "done" : ""}">${money(r.amount)}</div>
        <button class="item-delete" data-del-rec="${r.id}" aria-label="刪除">✕</button>
      </li>`).join("");

    list.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const r = state.recurring.find(x => x.id === btn.getAttribute("data-toggle"));
        r.done = !r.done;
        renderRecurring();
        saveState(state);
      });
    });
    list.querySelectorAll("[data-del-rec]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.recurring = state.recurring.filter(r => r.id !== btn.getAttribute("data-del-rec"));
        renderRecurring();
        saveState(state);
      });
    });
  }

  document.getElementById("addRecurringBtn").addEventListener("click", () => {
    openModal({
      title: "新增固定繳費項目",
      fields: [
        { key: "name", label: "項目名稱", type: "text", placeholder: "例如：房租、水電費" },
        { key: "amount", label: "金額", type: "number", placeholder: "0" }
      ],
      onSave: (v) => {
        if (!v.name) return;
        state.recurring.push({ id: uid(), name: v.name, amount: parseFloat(v.amount) || 0, done: false });
        renderRecurring();
      }
    });
  });

  /* ================= 通用 Modal =================
     儲存動作統一放在「關閉 Modal 之後」才執行，確保發布出去的
     文件快照裡，Modal 已經是關閉狀態（不會下次打開就看到彈窗）。 */
  const modalOverlay = document.getElementById("modalOverlay");
  const modalBody = document.getElementById("modalBody");

  function openModal({ title, fields, onSave }) {
    modalBody.innerHTML = `
      <h3>${title}</h3>
      ${fields.map(f => `
        <label class="field-label">${f.label}</label>
        <input class="text-input" type="${f.type}" placeholder="${f.placeholder || ""}" data-field="${f.key}">
      `).join("")}
      <div class="modal-actions">
        <button class="btn-cancel" id="modalCancel">取消</button>
        <button class="btn-save" id="modalSave">儲存</button>
      </div>`;
    modalOverlay.classList.add("open");

    modalBody.querySelector("#modalCancel").addEventListener("click", closeModal);
    modalBody.querySelector("#modalSave").addEventListener("click", () => {
      const values = {};
      fields.forEach(f => {
        values[f.key] = modalBody.querySelector(`[data-field="${f.key}"]`).value.trim();
      });
      onSave(values);
      closeModal();
      saveState(state);
    });
  }

  function closeModal() {
    modalOverlay.classList.remove("open");
    modalBody.innerHTML = "";
  }

  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  /* ================= 分頁切換 ================= */
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab}`));

      const titles = {
        home: "今天想記點什麼？",
        chart: "看看這個月花去哪了",
        accounts: "帳戶總覽",
        cards: "信用卡管理",
        checklist: "本月固定支出"
      };
      document.getElementById("pageTitle").textContent = titles[tab] || "拾光記帳";
    });
  });

  /* ================= 初始化 ================= */
  function initDate() {
    const now = new Date();
    const days = ["日","一","二","三","四","五","六"];
    document.getElementById("todayDate").textContent =
      `${now.getMonth() + 1}/${now.getDate()} 週${days[now.getDay()]}`;
  }

  initDate();
  renderPaymentOptions(paymentSelect);
  renderHome();
  renderChart();
  renderAccounts();
  renderCards();
  renderRecurring();
  embedStateInDom(state);

  initCloud();

  /* ---------------- PWA：註冊 Service Worker（離線快取） ----------------
     只有一般網頁環境（例如 GitHub Pages）才有意義；Claude Artifact
     環境沒有 sw.js 這個檔案可以註冊，失敗會被下面的 catch 靜默吸收。 */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        /* 開發環境或不支援時靜默略過，不影響一般網頁使用 */
      });
    });
  }

})();
