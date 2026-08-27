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

  /* ---------------- 禁止手機雙指縮放 / 雙擊縮放 ----------------
     CSS 的 touch-action 跟 viewport meta 的 maximum-scale／user-scalable
     在部分瀏覽器（特別是 iOS Safari 10 之後）其實會被忽略，所以額外用
     JS 攔截手勢事件當作第二層保險：
     - gesturestart/gesturechange 是 Safari 專屬的雙指縮放手勢事件。
     - touchmove 一旦偵測到兩指以上，代表使用者正在 pinch，直接擋掉。
     - touchend 距離上一次 touchend 在 300ms 內，視為雙擊，也擋掉，
       避免快速點兩下把畫面放大。 */
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("gesturechange", (e) => e.preventDefault());
  document.addEventListener("touchmove", (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  /* ---------------- 支出分類設定 ---------------- */
  const CATEGORIES = [
    { key: "吃飯",        color: "var(--c-food)",    keywords: ["早餐","午餐","晚餐","消夜","宵夜","咖啡","飲料","便當","餐廳","小吃","火鍋","燒烤","飯","麵","吃","茶","星巴克","超商","熱炒","早午餐","甜點","蛋糕","滷味","食材","買菜","生鮮","菜市場","果菜","蔬菜","水果","海鮮","豬肉","雞肉","牛肉","市場","肉","蛋","菜","優格","奇亞籽","食用油","橄欖油","沙拉油","苦茶油","麻油","堅果","牛奶","起司","豆腐","雞蛋"] },
    { key: "娛樂",        color: "var(--c-fun)",     keywords: ["電影","KTV","唱歌","展覽","演唱會","旅遊","酒吧","門票","樂園","遊戲","娛樂","景點","飯店","住宿","機票"] },
    { key: "生活用品",     color: "var(--c-daily)",   keywords: ["衛生紙","清潔","日用品","超市","全聯","家樂福","寶雅","洗髮精","牙膏","衛生棉","生活","雜貨","文具"] },
    { key: "油錢/停車費",  color: "var(--c-fuel)",    keywords: ["加油","停車","油錢","停車費","高速公路","ETC","過路費","機車保養","汽車保養","洗車"] },
    { key: "會員費用",     color: "var(--c-member)",  keywords: ["訂閱","會員","netflix","spotify","健身房","月費","年費","disney","youtube"] },
    { key: "服飾",        color: "var(--c-clothes)", keywords: ["衣服","鞋子","包包","飾品","服飾","買衣","uniqlo","zara","gu","outlet","帽子","襪子"] },
    { key: "奢侈品",       color: "var(--c-luxury)",  keywords: ["精品","名牌","珠寶","手錶","lv","gucci","chanel","奢侈","名錶","限量"] },
    { key: "投資",        color: "var(--c-invest)",  keywords: ["買股","股票","定期定額","etf","基金","加碼","進場","證券","期貨","入手股","買進"] },
    { key: "調整",        color: "var(--c-adjust)",  keywords: ["調整","校正","更正","餘額調整","結餘調整","對帳","初始餘額","期初"] }
  ];
  // 這些是「內建」關鍵字，程式碼更新時會調整；使用者也可以在
  // 「分類關鍵字」設定裡自行新增專屬關鍵字（存在 state 裡、會跟著同步）。
  const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));
  const FALLBACK_CATEGORY = "生活用品";

  function categorize(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    for (const cat of CATEGORIES) {
      const custom = (state.categoryKeywords && state.categoryKeywords[cat.key]) || [];
      if (cat.keywords.concat(custom).some(k => t.includes(k.toLowerCase()))) return cat.key;
    }
    return FALLBACK_CATEGORY;
  }

  /* ---------------- 收入分類設定 ---------------- */
  const INCOME_CATEGORIES = [
    { key: "薪資收入", color: "var(--c-salary)",    keywords: ["薪水","薪資","月薪","工資","獎金","年終"] },
    { key: "生活費",   color: "var(--c-allowance)", keywords: ["生活費","家用","零用錢","孝親費"] },
    { key: "股利收入", color: "var(--c-dividend)",  keywords: ["股利","股息","配息","除權","除息"] },
    { key: "投資",     color: "var(--c-invest)",    keywords: ["賣股","出場","賣出","股票","證券","期貨","獲利了結","出清"] },
    { key: "調整",     color: "var(--c-adjust)",    keywords: ["調整","校正","更正","餘額調整","結餘調整","對帳","初始餘額","期初"] },
    { key: "其他收入", color: "var(--c-other-income)", keywords: [] }
  ];
  const INCOME_CATEGORY_MAP = Object.fromEntries(INCOME_CATEGORIES.map(c => [c.key, c]));
  const INCOME_FALLBACK_CATEGORY = "其他收入";

  function categorizeIncome(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    for (const cat of INCOME_CATEGORIES) {
      const custom = (state.incomeCategoryKeywords && state.incomeCategoryKeywords[cat.key]) || [];
      if (cat.keywords.concat(custom).some(k => t.includes(k.toLowerCase()))) return cat.key;
    }
    return INCOME_FALLBACK_CATEGORY;
  }

  function categoryColor(category, type) {
    if (type === "income") {
      return (INCOME_CATEGORY_MAP[category] || {}).color || "var(--c-other-income)";
    }
    return (CATEGORY_MAP[category] || {}).color || "var(--text-faint)";
  }

  /* ---------------- 狀態 / 儲存 ---------------- */
  const STORAGE_KEY = "healing-ledger-v1";

  function currentMonthKey(d) {
    const now = d || new Date();
    return now.getFullYear() + "-" + (now.getMonth() + 1);
  }

  function seedState() {
    const now = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const thisMonth = (day) => iso(new Date(now.getFullYear(), now.getMonth(), day));
    const mKey = currentMonthKey(now);

    return {
      updatedAt: Date.now(),
      cashBalance: 1500,
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
        { id: "r1", name: "房租", amount: 12000, done: false, resetDay: 1, lastResetMonth: mKey },
        { id: "r2", name: "電費", amount: 1200, done: false, resetDay: 10, lastResetMonth: mKey },
        { id: "r3", name: "網路費", amount: 799, done: true, resetDay: 5, lastResetMonth: mKey },
        { id: "r4", name: "健身房會員", amount: 1000, done: false, resetDay: 1, lastResetMonth: mKey }
      ],
      transactions: [
        { id: "t1", type: "expense", date: thisMonth(3),  item: "午餐便當",   amount: 120,  category: "吃飯",       paymentId: "cash" },
        { id: "t2", type: "expense", date: thisMonth(5),  item: "全聯日用品", amount: 640,  category: "生活用品",   paymentId: "a1" },
        { id: "t3", type: "expense", date: thisMonth(8),  item: "加油",       amount: 800,  category: "油錢/停車費", paymentId: "c1" },
        { id: "t4", type: "expense", date: thisMonth(10), item: "看電影",     amount: 320,  category: "娛樂",       paymentId: "c1" },
        { id: "t5", type: "expense", date: thisMonth(14), item: "Netflix 訂閱", amount: 390, category: "會員費用",  paymentId: "a2" },
        { id: "t6", type: "expense", date: thisMonth(18), item: "UNIQLO 買衣", amount: 1290, category: "服飾",      paymentId: "c2" },
        { id: "t7", type: "income",  date: thisMonth(5),  item: "薪資入帳",   amount: 45000, category: "薪資收入",  paymentId: "a1" }
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
    migrateState(chosen);
    return chosen;
  }

  // 舊資料相容：固定繳費項目補上各自的重置日；交易紀錄補上 type；
  // 每個分類補上使用者自訂關鍵字的儲存位置（只在缺少時建立空陣列，
  // 絕不覆蓋使用者已經新增過的自訂關鍵字）
  function migrateState(s) {
    const mKey = currentMonthKey();
    // 現金：原本只是記帳時的一個付款選項，沒有真正記錄餘額；現在跟銀行
    // 帳戶一樣有自己的餘額，可以在「帳戶」分頁查看／調整。舊資料沒有
    // 這個欄位的話，不能直接當成 0——有些人（包含在這之前就已經用「調整」
    // 分類手動記過一筆現金收入來代表目前現金餘額）過去記的現金相關紀錄
    // 其實是有意義的，所以用「重播」過去所有現金付款方式的支出/收入/
    // 信用卡繳款，算出遷移當下現金應該有多少，而不是讓數字憑空歸零。
    if (typeof s.cashBalance !== "number") {
      let cash = 0;
      (s.transactions || []).forEach(t => {
        if (t.paymentId !== "cash") return;
        if (t.type === "cardpayment") cash -= t.amount;
        else if ((t.type || "expense") === "income") cash += t.amount;
        else if ((t.type || "expense") === "expense") cash -= t.amount;
      });
      s.cashBalance = cash;
    }
    const legacyResetDay = s.recurringResetDay || 1;
    (s.recurring || []).forEach(r => {
      if (!r.resetDay) r.resetDay = legacyResetDay;
      // 沒有重置紀錄的舊資料：視為「這個月已經處理過」，避免一更新程式碼
      // 就把使用者已經勾選的項目重置掉
      if (!r.lastResetMonth) r.lastResetMonth = s.recurringLastResetMonth || mKey;
    });
    (s.transactions || []).forEach(t => {
      if (!t.type) t.type = "expense";
    });
    // 信用卡：把「本期應繳金額」（statementAmount，結帳日已鎖定、等
    // 繳款截止日要繳的錢）跟「已刷卡未出帳金額」（unbilled，結帳日之後
    // 新刷的、算在下一期帳單的錢）分開追蹤。舊資料只有一個 unbilled
    // 欄位，遷移時當成「本期應繳」處理（比較符合使用者原本輸入這個
    // 欄位時的認知），並把 lastBilledMonth 設成這個月，避免遷移完
    // 馬上又被下面的結帳邏輯誤判成「這個月還沒結帳」而重複合併一次。
    (s.cards || []).forEach(c => {
      if (c.statementAmount === undefined) {
        c.statementAmount = c.unbilled || 0;
        c.unbilled = 0;
      }
      if (!c.lastBilledMonth) c.lastBilledMonth = mKey;
    });
    if (!s.categoryKeywords) s.categoryKeywords = {};
    CATEGORIES.forEach(c => {
      if (!Array.isArray(s.categoryKeywords[c.key])) s.categoryKeywords[c.key] = [];
    });
    if (!s.incomeCategoryKeywords) s.incomeCategoryKeywords = {};
    INCOME_CATEGORIES.forEach(c => {
      if (!Array.isArray(s.incomeCategoryKeywords[c.key])) s.incomeCategoryKeywords[c.key] = [];
    });
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

  async function initCloud() {
    if (typeof window.claude === "undefined" || typeof window.claude.use !== "function") {
      return;
    }
    try {
      cloudApi = await window.claude.use("artifact");
    } catch (e) {
      cloudApi = null;
    }
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

  /* ---------------- 每筆固定繳費各自的每月自動重置 ----------------
     只在載入當下判斷、只更動本機資料；真正發布給雲端的動作
     會等到使用者下一次實際操作（新增/刪除/勾選…）時才一併送出，
     符合「只在使用者互動後才發布」的原則。 */
  function maybeResetRecurring() {
    const now = new Date();
    const mKey = currentMonthKey(now);
    let changed = false;
    state.recurring.forEach(r => {
      if (r.lastResetMonth !== mKey && now.getDate() >= r.resetDay) {
        r.done = false;
        // 上一期繳款留下的那筆交易紀錄本身不會動（是已經花掉的真實支出，
        // 要繼續留在帳本裡），只是解除跟這個待辦項目的關聯，這樣新的一期
        // 勾選繳款時才會另外開一筆新的紀錄，不會誤刪到上一期的。
        r.lastTxId = null;
        r.lastResetMonth = mKey;
        changed = true;
      }
    });
    if (changed) persistLocal(state);
  }
  maybeResetRecurring();

  /* ---------------- 信用卡結帳日：把「已刷卡未出帳」併入「本期應繳」 ----------------
     每張卡結帳日一到，就把這段期間累積的 unbilled（已刷卡未出帳）併進
     statementAmount（本期應繳，繳款截止日前要繳的錢），unbilled 歸零、
     重新開始累積下一期的新刷卡金額。用「合併」而不是「取代」，所以就算
     上一期還沒繳完也不會不見，會繼續累加在 statementAmount 上——這樣
     不管有沒有準時繳款，金額永遠只會被記錄、合併，不會被自動清掉或刪除。
     同樣只在載入當下判斷、只更動本機資料，真正發布給雲端會等使用者
     下一次實際操作時才一併送出。 */
  function maybeCloseBillingCycle() {
    const now = new Date();
    const mKey = currentMonthKey(now);
    let changed = false;
    state.cards.forEach(c => {
      if (c.lastBilledMonth !== mKey && now.getDate() >= c.billingDay) {
        c.statementAmount = (c.statementAmount || 0) + (c.unbilled || 0);
        c.unbilled = 0;
        c.lastBilledMonth = mKey;
        changed = true;
      }
    });
    if (changed) persistLocal(state);
  }
  maybeCloseBillingCycle();

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

  // 收入不能存進信用卡，所以 excludeCards 會把信用卡選項拿掉
  function renderPaymentOptions(selectEl, opts) {
    const excludeCards = opts && opts.excludeCards;
    let html = `<option value="cash">現金</option>`;
    if (state.accounts.length) {
      html += `<optgroup label="銀行帳戶">`;
      html += state.accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join("");
      html += `</optgroup>`;
    }
    if (!excludeCards && state.cards.length) {
      html += `<optgroup label="信用卡">`;
      html += state.cards.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
      html += `</optgroup>`;
    }
    const prevValue = selectEl.value;
    selectEl.innerHTML = html;
    if ([...selectEl.options].some(o => o.value === prevValue)) selectEl.value = prevValue;
  }

  /* ================= 首頁：快速記帳 ================= */
  const itemInput = document.getElementById("itemInput");
  const amountInput = document.getElementById("amountInput");
  const paymentSelect = document.getElementById("paymentSelect");
  const paymentLabelEl = document.getElementById("paymentLabel");
  const itemLabelEl = document.getElementById("itemLabel");
  const catDot = document.getElementById("catDot");
  const catLabel = document.getElementById("catLabel");
  const addBtn = document.getElementById("addBtn");
  const formHint = document.getElementById("formHint");
  const typeToggle = document.getElementById("typeToggle");

  let entryType = "expense"; // 'expense' | 'income'

  typeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".type-btn");
    if (!btn) return;
    entryType = btn.getAttribute("data-type");
    typeToggle.querySelectorAll(".type-btn").forEach(b => b.classList.toggle("active", b === btn));

    if (entryType === "income") {
      itemLabelEl.textContent = "收入項目";
      itemInput.placeholder = "例如：薪資入帳、股利、生活費";
      paymentLabelEl.textContent = "存入帳戶";
      addBtn.textContent = "新增收入";
    } else {
      itemLabelEl.textContent = "花費項目";
      itemInput.placeholder = "例如：星巴克拿鐵、加油、房租";
      paymentLabelEl.textContent = "支付方式";
      addBtn.textContent = "新增紀錄";
    }
    renderPaymentOptions(paymentSelect, { excludeCards: entryType === "income" });
    updateCategoryPreview();
  });

  function updateCategoryPreview() {
    const text = itemInput.value.trim();
    const guess = entryType === "income" ? categorizeIncome(text) : categorize(text);
    if (guess) {
      catDot.style.background = categoryColor(guess, entryType);
      catLabel.textContent = `自動分類為「${guess}」`;
      catLabel.style.color = "var(--text-primary)";
    } else {
      catDot.style.background = "var(--text-faint)";
      catLabel.textContent = "輸入後將自動判斷分類";
      catLabel.style.color = "var(--text-secondary)";
    }
  }

  itemInput.addEventListener("input", updateCategoryPreview);

  addBtn.addEventListener("click", () => {
    const item = itemInput.value.trim();
    const amount = parseFloat(amountInput.value);
    const paymentId = paymentSelect.value;

    if (!item) { showHint(entryType === "income" ? "請輸入收入項目" : "請輸入花費項目"); return; }
    if (!amount || amount <= 0) { showHint("請輸入有效金額"); return; }

    const category = entryType === "income" ? categorizeIncome(item) : categorize(item);

    const tx = {
      id: uid(),
      type: entryType,
      date: new Date().toISOString().slice(0, 10),
      item, amount, category, paymentId
    };
    state.transactions.unshift(tx);
    // 支出：sign +1（帳戶減少／卡片未出帳增加）。收入：sign -1，剛好是同一個
    // 函式反過來的效果（帳戶增加），現金則兩種情況都不影響任何帳戶。
    applyPaymentDelta(paymentId, amount, entryType === "expense" ? +1 : -1);

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
    // sign +1 = 支出效果（帳戶／現金減少、卡片未出帳增加）；sign -1 =
    // 收入效果（帳戶／現金增加）或刪除一筆支出時的還原。
    if (paymentId === "cash") { state.cashBalance -= amount * sign; return; }
    const acc = state.accounts.find(a => a.id === paymentId);
    if (acc) { acc.balance -= amount * sign; return; }
    const card = state.cards.find(c => c.id === paymentId);
    if (card) { card.unbilled += amount * sign; }
  }

  // sign +1 = 執行轉帳（from 帳戶減少、to 帳戶增加）；sign -1 = 刪除轉帳紀錄時還原
  function applyTransfer(fromId, toId, amount, sign) {
    const fromAcc = state.accounts.find(a => a.id === fromId);
    const toAcc = state.accounts.find(a => a.id === toId);
    if (fromAcc) fromAcc.balance -= amount * sign;
    if (toAcc) toAcc.balance += amount * sign;
  }

  // 信用卡繳款：sign +1 = 執行繳款（付款帳戶／現金減少、該卡本期應繳金額
  // statementAmount 減少）；sign -1 = 刪除這筆繳款紀錄時還原。只還
  // 「本期應繳」，不動已刷卡未出帳（unbilled）的部分。
  function payCardBill(cardId, paymentId, amount, sign) {
    const card = state.cards.find(c => c.id === cardId);
    if (card) card.statementAmount -= amount * sign;
    if (paymentId === "cash") { state.cashBalance -= amount * sign; return; }
    const acc = state.accounts.find(a => a.id === paymentId);
    if (acc) acc.balance -= amount * sign;
  }

  function deleteTransaction(id) {
    const idx = state.transactions.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tx = state.transactions[idx];
    if (tx.type === "transfer") {
      applyTransfer(tx.fromAccountId, tx.toAccountId, tx.amount, -1);
    } else if (tx.type === "cardpayment") {
      payCardBill(tx.cardId, tx.paymentId, tx.amount, -1);
    } else {
      applyPaymentDelta(tx.paymentId, tx.amount, tx.type === "income" ? +1 : -1);
    }
    // 如果這筆是從「週期性繳費清單」勾選繳款自動記下來的，刪掉它也要
    // 把那個待辦項目取消勾選，不然會變成錢已經還回來了、清單上卻還
    // 顯示「已繳」的不一致狀態。
    if (tx.recurringId) {
      const rec = state.recurring.find(r => r.id === tx.recurringId);
      if (rec) { rec.done = false; rec.lastTxId = null; }
      renderRecurring();
    }
    state.transactions.splice(idx, 1);
    renderHome(); renderChart(); renderAccounts(); renderCards();
    saveState(state);
  }

  // 所有刪除動作的防呆確認視窗：傳入要顯示的說明文字，以及按下「刪除」
  // 後真正執行的動作。取消或點背景都不會刪除任何東西。
  function confirmDelete(message, onConfirm) {
    modalBody.innerHTML = `
      <h3>確定要刪除嗎？</h3>
      <p class="confirm-message">${message}</p>
      <div class="modal-actions">
        <button class="btn-cancel" id="confirmCancelBtn">取消</button>
        <button class="btn-danger" id="confirmDeleteBtn">刪除</button>
      </div>`;
    modalOverlay.classList.add("open");
    modalBody.querySelector("#confirmCancelBtn").addEventListener("click", closeModal);
    modalBody.querySelector("#confirmDeleteBtn").addEventListener("click", () => {
      closeModal();
      onConfirm();
    });
  }

  function monthTransactions(offset, type) {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const y = target.getFullYear(), m = target.getMonth();
    return state.transactions.filter(t => {
      if (type && (t.type || "expense") !== type) return false;
      // 調整只是拿來校正帳戶/現金餘額用的（例如手動輸入初始餘額、對帳
      // 誤差），不是真正的花費或收入，所以本月支出/收入統計跟圓餅圖都
      // 不列入——但金額還是會照樣影響帳戶餘額，也還是會留在最近紀錄裡。
      if (t.category === "調整") return false;
      const d = new Date(t.date);
      return d.getFullYear() === y && d.getMonth() === m;
    });
  }
  const monthTotalSpend = (offset = 0) => monthTransactions(offset, "expense");
  const monthTotalIncome = (offset = 0) => monthTransactions(offset, "income");

  function renderHome() {
    const spendTotal = monthTotalSpend(0).reduce((s, t) => s + t.amount, 0);
    document.getElementById("monthTotal").textContent = money(spendTotal);

    const incomeTotal = monthTotalIncome(0).reduce((s, t) => s + t.amount, 0);
    document.getElementById("monthIncome").textContent = money(incomeTotal);

    const accTotal = state.accounts.reduce((s, a) => s + a.balance, 0) + state.cashBalance;
    document.getElementById("totalBalance").textContent = money(accTotal);

    renderPaymentOptions(paymentSelect, { excludeCards: entryType === "income" });

    const list = document.getElementById("recentList");
    const empty = document.getElementById("recentEmpty");
    const recent = state.transactions.slice(0, 8);
    empty.style.display = recent.length ? "none" : "block";
    list.innerHTML = recent.map(t => {
      if (t.type === "transfer") {
        return `
          <li class="list-item">
            <span class="item-dot" style="background:var(--c-adjust)"></span>
            <div class="item-main">
              <div class="item-title">${escapeHtml(t.item)}</div>
              <div class="item-sub">${t.date} · 從 ${paymentLabel(t.fromAccountId)} 轉到 ${paymentLabel(t.toAccountId)}</div>
            </div>
            <div class="item-amount">⇄ ${money(t.amount)}</div>
            <button class="item-delete" data-del="${t.id}" aria-label="刪除">✕</button>
          </li>`;
      }
      if (t.type === "cardpayment") {
        const card = state.cards.find(c => c.id === t.cardId);
        const cardName = card ? card.name : "未知信用卡";
        return `
          <li class="list-item">
            <span class="item-dot" style="background:var(--c-adjust)"></span>
            <div class="item-main">
              <div class="item-title">${escapeHtml(cardName)} 繳款</div>
              <div class="item-sub">${t.date} · 用 ${paymentLabel(t.paymentId)} 支付</div>
            </div>
            <div class="item-amount">💳 ${money(t.amount)}</div>
            <button class="item-delete" data-del="${t.id}" aria-label="刪除">✕</button>
          </li>`;
      }
      const color = categoryColor(t.category, t.type);
      const isIncome = t.type === "income";
      return `
        <li class="list-item">
          <span class="item-dot" style="background:${color}"></span>
          <div class="item-main">
            <div class="item-title">${escapeHtml(t.item)}</div>
            <div class="item-sub">${t.date} · ${t.category} · ${paymentLabel(t.paymentId)}</div>
          </div>
          <div class="item-amount${isIncome ? " income" : ""}">${isIncome ? "+" : "-"}${money(t.amount)}</div>
          <button class="item-delete" data-del="${t.id}" aria-label="刪除">✕</button>
        </li>`;
    }).join("");

    list.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del");
        const tx = state.transactions.find(t => t.id === id);
        if (!tx) return;
        const desc = tx.type === "transfer"
          ? `「${escapeHtml(tx.item)}」⇄ ${money(tx.amount)} 這筆轉帳紀錄刪除後無法復原，兩個帳戶的餘額會各自還原。`
          : tx.type === "cardpayment"
          ? `這筆信用卡繳款紀錄（💳 ${money(tx.amount)}）刪除後無法復原，支付帳戶的餘額跟信用卡的本期應繳金額都會還原。`
          : `「${escapeHtml(tx.item)}」${tx.type === "income" ? "+" : "-"}${money(tx.amount)} 這筆紀錄刪除後無法復原。`;
        confirmDelete(desc, () => deleteTransaction(id));
      });
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  /* ================= 圖表（支出／收入各一個圓餅圖，共用同一個月份） ================= */
  let chartMonthOffset = 0;

  document.getElementById("prevMonth").addEventListener("click", () => { chartMonthOffset--; renderChart(); });
  document.getElementById("nextMonth").addEventListener("click", () => {
    if (chartMonthOffset < 0) chartMonthOffset++;
    renderChart();
  });

  // 共用的甜甜圈圖繪製邏輯：傳入要更新的 DOM id 跟資料，支出／收入圖表都靠它畫
  function renderDonutChart({ svgId, totalId, legendId, emptyId, entries }) {
    const svg = document.getElementById(svgId);
    const legend = document.getElementById(legendId);
    const emptyEl = document.getElementById(emptyId);
    const total = entries.reduce((s, e) => s + e.value, 0);
    document.getElementById(totalId).textContent = money(total);

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

    const sorted = entries.filter(e => e.value > 0).sort((a, b) => b.value - a.value);

    svg.innerHTML = sorted.map(e => {
      const frac = e.value / total;
      const len = frac * circumference;
      const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${resolveColor(e.color)}" stroke-width="26"
        stroke-dasharray="${len} ${circumference - len}"
        stroke-dashoffset="${-offset}" />`;
      offset += len;
      return circle;
    }).join("");

    legend.innerHTML = sorted.map(e => `
      <li>
        <span class="item-dot" style="background:${e.color}"></span>
        <span class="legend-name">${e.key}</span>
        <span class="legend-percent">${Math.round((e.value / total) * 100)}%</span>
        <span class="legend-amount">${money(e.value)}</span>
      </li>`).join("");
  }

  function categoryTotals(transactions) {
    const totals = {};
    transactions.forEach(t => { totals[t.category] = (totals[t.category] || 0) + t.amount; });
    return totals;
  }

  function renderChart() {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + chartMonthOffset, 1);
    document.getElementById("chartMonthLabel").textContent =
      `${target.getFullYear()} 年 ${target.getMonth() + 1} 月`;

    const expenseTotals = categoryTotals(monthTotalSpend(chartMonthOffset));
    renderDonutChart({
      svgId: "donutChart", totalId: "donutTotal", legendId: "chartLegend", emptyId: "chartEmpty",
      entries: CATEGORIES.map(c => ({ key: c.key, color: c.color, value: expenseTotals[c.key] || 0 }))
    });

    const incomeTotals = categoryTotals(monthTotalIncome(chartMonthOffset));
    renderDonutChart({
      svgId: "donutChartIncome", totalId: "donutTotalIncome", legendId: "chartLegendIncome", emptyId: "chartEmptyIncome",
      entries: INCOME_CATEGORIES.map(c => ({ key: c.key, color: c.color, value: incomeTotals[c.key] || 0 }))
    });
  }

  /* ================= 帳戶 ================= */
  function renderAccounts() {
    const list = document.getElementById("accountList");
    // 現金固定釘在最上面，且不能刪除（不是「新增」出來的帳戶，是內建
    // 的一個付款方式，只是現在多了可以查看／調整的餘額）；只給編輯按鈕。
    const cashRow = `
      <li class="list-item">
        <span class="item-dot" style="background:var(--c-fuel)"></span>
        <div class="item-main">
          <div class="item-title">現金</div>
          <div class="item-sub">隨身現金</div>
        </div>
        <div class="item-amount">${money(state.cashBalance)}</div>
        <button class="item-edit" id="editCashBtn" aria-label="編輯">✎</button>
      </li>`;

    list.innerHTML = cashRow + state.accounts.map(a => `
      <li class="list-item">
        <span class="item-dot" style="background:var(--c-fun)"></span>
        <div class="item-main">
          <div class="item-title">${escapeHtml(a.name)}</div>
          <div class="item-sub">銀行帳戶</div>
        </div>
        <div class="item-amount">${money(a.balance)}</div>
        <button class="item-delete" data-del-acc="${a.id}" aria-label="刪除">✕</button>
      </li>`).join("");

    document.getElementById("editCashBtn").addEventListener("click", openCashModal);

    list.querySelectorAll("[data-del-acc]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del-acc");
        const acc = state.accounts.find(a => a.id === id);
        if (!acc) return;
        confirmDelete(`帳戶「${escapeHtml(acc.name)}」（餘額 ${money(acc.balance)}）刪除後無法復原，過去用這個帳戶記的紀錄不會被刪除，但會顯示為未知帳戶。`, () => {
          state.accounts = state.accounts.filter(a => a.id !== id);
          renderAccounts(); renderHome();
          saveState(state);
        });
      });
    });

    document.getElementById("accountsTotal").textContent =
      money(state.accounts.reduce((s, a) => s + a.balance, 0) + state.cashBalance);
  }

  // 現金餘額用一個很單純的單欄位 modal 直接調整（例如提款、發現數字對
  // 不上想手動校正），不透過記一筆支出/收入，避免又跑出一筆不必要的
  // 交易紀錄——跟信用卡編輯視窗一樣，是「設定目前的值」而不是「加減」。
  function openCashModal() {
    openModal({
      title: "調整現金餘額",
      fields: [
        { key: "cashBalance", label: "目前現金餘額", type: "number", placeholder: "0" }
      ],
      initial: { cashBalance: state.cashBalance },
      onSave: (v) => {
        state.cashBalance = parseFloat(v.cashBalance) || 0;
        renderAccounts(); renderHome();
      }
    });
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

  /* ================= 帳戶互轉 =================
     只在自己的銀行帳戶之間搬錢，不算支出也不算收入，所以不會影響
     本月支出/收入統計或圓餅圖；有紀錄在「最近紀錄」裡方便回頭查。 */
  document.getElementById("transferBtn").addEventListener("click", openTransferModal);

  function openTransferModal() {
    if (state.accounts.length < 2) {
      modalBody.innerHTML = `
        <h3>帳戶互轉</h3>
        <p class="confirm-message">要先有兩個以上的銀行帳戶才能互轉，先去新增一個帳戶吧。</p>
        <div class="modal-actions">
          <button class="btn-save" id="transferOkBtn" style="flex:1;">好</button>
        </div>`;
      modalOverlay.classList.add("open");
      modalBody.querySelector("#transferOkBtn").addEventListener("click", closeModal);
      return;
    }

    const accountOptions = state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
    modalBody.innerHTML = `
      <h3>帳戶互轉</h3>
      <label class="field-label">從</label>
      <select id="transferFrom" class="text-input">${accountOptions}</select>
      <label class="field-label">轉到</label>
      <select id="transferTo" class="text-input">${accountOptions}</select>
      <label class="field-label">金額</label>
      <input id="transferAmount" class="text-input" type="number" min="0" placeholder="0">
      <label class="field-label">備註（選填）</label>
      <input id="transferNote" class="text-input" placeholder="例如：生活費撥款">
      <p class="hint-text" id="transferHint"></p>
      <div class="modal-actions">
        <button class="btn-cancel" id="transferCancelBtn">取消</button>
        <button class="btn-save" id="transferSaveBtn">轉帳</button>
      </div>`;
    modalOverlay.classList.add("open");

    const fromSel = modalBody.querySelector("#transferFrom");
    const toSel = modalBody.querySelector("#transferTo");
    toSel.selectedIndex = 1; // 預設「到」跟「從」不是同一個帳戶

    modalBody.querySelector("#transferCancelBtn").addEventListener("click", closeModal);
    modalBody.querySelector("#transferSaveBtn").addEventListener("click", () => {
      const fromId = fromSel.value;
      const toId = toSel.value;
      const amount = parseFloat(modalBody.querySelector("#transferAmount").value);
      const hint = modalBody.querySelector("#transferHint");

      if (fromId === toId) { hint.textContent = "「從」跟「轉到」不能是同一個帳戶"; return; }
      if (!amount || amount <= 0) { hint.textContent = "請輸入有效金額"; return; }

      const fromAcc = state.accounts.find(a => a.id === fromId);
      const toAcc = state.accounts.find(a => a.id === toId);
      const note = modalBody.querySelector("#transferNote").value.trim();

      state.transactions.unshift({
        id: uid(),
        type: "transfer",
        date: new Date().toISOString().slice(0, 10),
        item: note || `${fromAcc.name} → ${toAcc.name}`,
        amount,
        fromAccountId: fromId,
        toAccountId: toId
      });
      applyTransfer(fromId, toId, amount, +1);

      closeModal();
      renderAccounts(); renderHome();
      saveState(state);
    });
  }

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
      const statementAmount = c.statementAmount || 0;
      const unbilled = c.unbilled || 0;
      // 到期badge只在「本期應繳」大於 0 時才顯示，避免明明沒有待繳金額
      // 卻還被一個逾期警示嚇到。
      const dueBlock = statementAmount > 0 ? (() => {
        const { daysLeft, cls } = nextDueInfo(c);
        const badgeText = daysLeft <= 0 ? "已逾期" : `${daysLeft} 天後到期`;
        return `<span class="due-badge ${cls}"><span class="due-dot"></span>${badgeText}</span>`;
      })() : `<span class="due-badge">目前無待繳</span>`;
      const limit = c.limit || 0;
      const totalOwed = statementAmount + unbilled; // 額度看的是這張卡總共欠多少，不分本期/下期
      const limitBlock = limit > 0 ? `
          <div class="credit-card-limit">
            <div class="limit-bar"><div class="limit-fill${totalOwed / limit >= 0.8 ? " high" : ""}" style="width:${Math.min(100, Math.max(0, (totalOwed / limit) * 100))}%"></div></div>
            <div class="limit-text">可用額度 ${money(Math.max(0, limit - totalOwed))} ／ 額度 ${money(limit)}</div>
          </div>` : "";
      const unbilledNote = unbilled > 0
        ? `<div class="credit-card-unbilled-note">已刷卡未出帳 ${money(unbilled)}（下期帳單，${c.billingDay} 號結帳後才會列入應繳）</div>`
        : "";
      return `
        <li class="credit-card ${CARD_THEMES[i % CARD_THEMES.length]}">
          <div class="credit-card-top">
            <span class="credit-card-name">${escapeHtml(c.name)}</span>
            <div class="credit-card-actions">
              <button class="credit-card-edit" data-edit-card="${c.id}" aria-label="編輯">✎</button>
              <button class="credit-card-delete" data-del-card="${c.id}" aria-label="刪除">✕</button>
            </div>
          </div>
          <div class="credit-card-amount">
            <small>本期應繳金額</small>
            ${money(statementAmount)}
          </div>${unbilledNote}${limitBlock}
          <div class="credit-card-bottom">
            <span>每月 ${c.billingDay} 號結帳 · ${c.dueDay} 號前繳款</span>
            ${dueBlock}
          </div>
          ${statementAmount > 0 ? `<button class="credit-card-pay-btn" data-pay-card="${c.id}">✓ 已繳款</button>` : ""}
        </li>`;
    }).join("");

    list.querySelectorAll("[data-pay-card]").forEach(btn => {
      btn.addEventListener("click", () => {
        const card = state.cards.find(c => c.id === btn.getAttribute("data-pay-card"));
        if (card) openCardPaymentModal(card);
      });
    });
    list.querySelectorAll("[data-del-card]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del-card");
        const card = state.cards.find(c => c.id === id);
        if (!card) return;
        const owed = (card.statementAmount || 0) + (card.unbilled || 0);
        confirmDelete(`信用卡「${escapeHtml(card.name)}」（目前欠款 ${money(owed)}）刪除後無法復原。`, () => {
          state.cards = state.cards.filter(c => c.id !== id);
          renderCards(); renderHome();
          saveState(state);
        });
      });
    });
    list.querySelectorAll("[data-edit-card]").forEach(btn => {
      btn.addEventListener("click", () => {
        const card = state.cards.find(c => c.id === btn.getAttribute("data-edit-card"));
        if (card) openCardModal(card);
      });
    });
  }

  function openCardModal(existing) {
    openModal({
      title: existing ? "編輯信用卡" : "新增信用卡",
      fields: [
        { key: "name", label: "卡片名稱", type: "text", placeholder: "例如：玉山 Only 卡" },
        { key: "statementAmount", label: "本期應繳金額（繳款截止日前要繳的錢）", type: "number", placeholder: "0" },
        { key: "unbilled", label: "已刷卡未出帳金額（下期才要繳，選填）", type: "number", placeholder: "0" },
        { key: "limit", label: "信用卡額度（選填，用來算可用額度）", type: "number", placeholder: "0 表示不設定" },
        { key: "billingDay", label: "結帳日（每月幾號）", type: "number", placeholder: "20" },
        { key: "dueDay", label: "繳款截止日（每月幾號）", type: "number", placeholder: "5" }
      ],
      initial: existing ? {
        name: existing.name, statementAmount: existing.statementAmount, unbilled: existing.unbilled,
        limit: existing.limit || "", billingDay: existing.billingDay, dueDay: existing.dueDay
      } : null,
      onSave: (v) => {
        if (!v.name) return;
        const data = {
          name: v.name,
          statementAmount: parseFloat(v.statementAmount) || 0,
          unbilled: parseFloat(v.unbilled) || 0,
          limit: parseFloat(v.limit) || 0,
          billingDay: Math.min(28, Math.max(1, parseInt(v.billingDay) || 20)),
          dueDay: Math.min(28, Math.max(1, parseInt(v.dueDay) || 5))
        };
        if (existing) {
          Object.assign(existing, data);
        } else {
          // 新卡的 lastBilledMonth 設成這個月：避免剛輸入好「本期應繳」跟
          // 「已刷卡未出帳」兩個分開的金額，一存檔就被結帳邏輯誤判成
          // 「這個月的結帳日還沒處理過」而立刻合併在一起。
          state.cards.push({ id: uid(), lastBilledMonth: currentMonthKey(), ...data });
        }
        renderCards(); renderHome();
      }
    });
  }

  /* ================= 信用卡繳款 =================
     記一筆「繳款」：從某個帳戶（或現金）付錢，把這張卡「本期應繳金額」
     （statementAmount）沖掉一部分或全部——只還本期已經出帳、快到期的
     錢，不會動到「已刷卡未出帳」（unbilled，屬於下一期帳單）的部分。
     這筆錢在買東西當下（applyPaymentDelta 把 unbilled 加上去的時候）
     就已經算過一次支出了，所以繳款本身不算新的支出，也不算收入 ——
     跟帳戶互轉一樣，只是單純的資金移動紀錄。 */
  function openCardPaymentModal(card) {
    if (card.statementAmount <= 0) {
      modalBody.innerHTML = `
        <h3>信用卡繳款</h3>
        <p class="confirm-message">「${escapeHtml(card.name)}」目前沒有應繳金額，不需要繳款。</p>
        <div class="modal-actions">
          <button class="btn-save" id="cardPayOkBtn" style="flex:1;">好</button>
        </div>`;
      modalOverlay.classList.add("open");
      modalBody.querySelector("#cardPayOkBtn").addEventListener("click", closeModal);
      return;
    }

    let amountMode = "full"; // 'full' | 'custom'
    const methodOptions = `<option value="cash">現金</option>` +
      state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");

    modalBody.innerHTML = `
      <h3>信用卡繳款 · ${escapeHtml(card.name)}</h3>
      <p class="hint-text" style="margin:0 0 4px;">本期應繳金額 ${money(card.statementAmount)}</p>
      <label class="field-label">繳款金額</label>
      <div class="type-toggle" id="cardPayAmountToggle">
        <button type="button" class="type-btn active" data-mode="full">全部</button>
        <button type="button" class="type-btn" data-mode="custom">自訂金額</button>
      </div>
      <input id="cardPayAmount" class="text-input" type="number" min="0" max="${card.statementAmount}" value="${card.statementAmount}" readonly style="margin-top:8px;">
      <label class="field-label">用什麼方式繳款</label>
      <select id="cardPayMethod" class="text-input">${methodOptions}</select>
      <p class="hint-text" id="cardPayHint"></p>
      <div class="modal-actions">
        <button class="btn-cancel" id="cardPayCancelBtn">取消</button>
        <button class="btn-save" id="cardPaySaveBtn">確認繳款</button>
      </div>`;
    modalOverlay.classList.add("open");

    const amountToggle = modalBody.querySelector("#cardPayAmountToggle");
    const amountInput = modalBody.querySelector("#cardPayAmount");
    const hint = modalBody.querySelector("#cardPayHint");

    amountToggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".type-btn");
      if (!btn) return;
      amountMode = btn.getAttribute("data-mode");
      amountToggle.querySelectorAll(".type-btn").forEach(b => b.classList.toggle("active", b === btn));
      if (amountMode === "full") {
        amountInput.value = card.statementAmount;
        amountInput.readOnly = true;
      } else {
        amountInput.readOnly = false;
        amountInput.value = "";
        amountInput.focus();
      }
    });

    modalBody.querySelector("#cardPayCancelBtn").addEventListener("click", closeModal);
    modalBody.querySelector("#cardPaySaveBtn").addEventListener("click", () => {
      const amount = parseFloat(amountInput.value);
      const paymentId = modalBody.querySelector("#cardPayMethod").value;
      if (!amount || amount <= 0) { hint.textContent = "請輸入有效金額"; return; }
      if (amount > card.statementAmount) { hint.textContent = `金額不能超過本期應繳金額 ${money(card.statementAmount)}`; return; }

      state.transactions.unshift({
        id: uid(),
        type: "cardpayment",
        date: new Date().toISOString().slice(0, 10),
        item: `${card.name} 繳款`,
        amount,
        cardId: card.id,
        paymentId
      });
      payCardBill(card.id, paymentId, amount, +1);

      closeModal();
      renderCards(); renderAccounts(); renderHome();
      saveState(state);
    });
  }

  document.getElementById("addCardBtn").addEventListener("click", () => openCardModal(null));

  /* ================= 週期性繳費（每筆各自設定重置日） ================= */
  function renderRecurring() {
    const list = document.getElementById("recurringList");
    const empty = document.getElementById("recurringEmpty");
    empty.style.display = state.recurring.length ? "none" : "block";

    list.innerHTML = state.recurring.map(r => `
      <li class="recurring-item">
        <button class="checkbox ${r.done ? "checked" : ""}" data-toggle="${r.id}" aria-label="標記完成">${r.done ? "✓" : ""}</button>
        <div class="recurring-main">
          <div class="recurring-name ${r.done ? "done" : ""}">${escapeHtml(r.name)}</div>
          <div class="recurring-sub">每月 ${r.resetDay} 號重置為未繳納</div>
        </div>
        <div class="recurring-amount ${r.done ? "done" : ""}">${money(r.amount)}</div>
        <div class="recurring-actions">
          <button class="item-edit" data-edit-rec="${r.id}" aria-label="編輯">✎</button>
          <button class="item-delete" data-del-rec="${r.id}" aria-label="刪除">✕</button>
        </div>
      </li>`).join("");

    list.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const r = state.recurring.find(x => x.id === btn.getAttribute("data-toggle"));
        if (!r) return;
        if (r.done) {
          // 取消勾選：把剛剛那筆繳款紀錄一併刪掉，付款帳戶/現金/信用卡
          // 未出帳金額都跟著還原，避免「打勾取消了、錢卻還是扣著」。
          if (r.lastTxId) {
            const idx = state.transactions.findIndex(t => t.id === r.lastTxId);
            if (idx !== -1) {
              const tx = state.transactions[idx];
              applyPaymentDelta(tx.paymentId, tx.amount, -1);
              state.transactions.splice(idx, 1);
            }
            r.lastTxId = null;
          }
          r.done = false;
          renderRecurring(); renderHome(); renderChart(); renderAccounts(); renderCards();
          saveState(state);
        } else {
          openRecurringPayModal(r);
        }
      });
    });
    list.querySelectorAll("[data-del-rec]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del-rec");
        const r = state.recurring.find(x => x.id === id);
        if (!r) return;
        confirmDelete(`固定繳費項目「${escapeHtml(r.name)}」（${money(r.amount)}）刪除後無法復原。`, () => {
          state.recurring = state.recurring.filter(x => x.id !== id);
          renderRecurring();
          saveState(state);
        });
      });
    });
    list.querySelectorAll("[data-edit-rec]").forEach(btn => {
      btn.addEventListener("click", () => {
        const r = state.recurring.find(x => x.id === btn.getAttribute("data-edit-rec"));
        if (r) openRecurringModal(r);
      });
    });
  }

  /* ================= 固定繳費：勾選繳款 =================
     點下待辦項目的勾選框時，先問「用什麼方式繳的」，選好之後才真的
     記一筆支出（帳戶/現金/信用卡未出帳跟著連動），並記住這筆交易的
     id（lastTxId），這樣取消勾選、或之後在「最近紀錄」直接刪掉這筆
     交易時，待辦清單才能同步把勾選狀態還原、不會兜不起來。 */
  function openRecurringPayModal(r) {
    const methodOptions = `<option value="cash">現金</option>` +
      (state.accounts.length ? `<optgroup label="銀行帳戶">` + state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("") + `</optgroup>` : "") +
      (state.cards.length ? `<optgroup label="信用卡">` + state.cards.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("") + `</optgroup>` : "");

    modalBody.innerHTML = `
      <h3>${escapeHtml(r.name)} 已繳款</h3>
      <label class="field-label">金額</label>
      <input id="recPayAmount" class="text-input" type="number" min="0" value="${r.amount}">
      <label class="field-label">用什麼方式繳的</label>
      <select id="recPayMethod" class="text-input">${methodOptions}</select>
      <p class="hint-text" id="recPayHint"></p>
      <div class="modal-actions">
        <button class="btn-cancel" id="recPayCancelBtn">取消</button>
        <button class="btn-save" id="recPaySaveBtn">確認</button>
      </div>`;
    modalOverlay.classList.add("open");

    modalBody.querySelector("#recPayCancelBtn").addEventListener("click", closeModal);
    modalBody.querySelector("#recPaySaveBtn").addEventListener("click", () => {
      const amount = parseFloat(modalBody.querySelector("#recPayAmount").value);
      const paymentId = modalBody.querySelector("#recPayMethod").value;
      const hint = modalBody.querySelector("#recPayHint");
      if (!amount || amount <= 0) { hint.textContent = "請輸入有效金額"; return; }

      const tx = {
        id: uid(),
        type: "expense",
        date: new Date().toISOString().slice(0, 10),
        item: r.name,
        amount,
        category: categorize(r.name),
        paymentId,
        recurringId: r.id
      };
      state.transactions.unshift(tx);
      applyPaymentDelta(paymentId, amount, +1);

      r.done = true;
      r.lastTxId = tx.id;

      closeModal();
      renderRecurring(); renderHome(); renderChart(); renderAccounts(); renderCards();
      saveState(state);
    });
  }

  function openRecurringModal(existing) {
    openModal({
      title: existing ? "編輯固定繳費項目" : "新增固定繳費項目",
      fields: [
        { key: "name", label: "項目名稱", type: "text", placeholder: "例如：房租、水電費" },
        { key: "amount", label: "金額", type: "number", placeholder: "0" },
        { key: "resetDay", label: "每月幾號自動重置為未繳納", type: "number", placeholder: "1" }
      ],
      initial: existing ? { name: existing.name, amount: existing.amount, resetDay: existing.resetDay } : null,
      onSave: (v) => {
        if (!v.name) return;
        const resetDay = Math.min(28, Math.max(1, parseInt(v.resetDay) || 1));
        if (existing) {
          existing.name = v.name;
          existing.amount = parseFloat(v.amount) || 0;
          existing.resetDay = resetDay;
        } else {
          state.recurring.push({
            id: uid(),
            name: v.name,
            amount: parseFloat(v.amount) || 0,
            done: false,
            resetDay,
            lastResetMonth: currentMonthKey()
          });
        }
        renderRecurring();
      }
    });
  }

  document.getElementById("addRecurringBtn").addEventListener("click", () => openRecurringModal(null));

  /* ================= 通用 Modal =================
     儲存動作統一放在「關閉 Modal 之後」才執行，確保發布出去的
     文件快照裡，Modal 已經是關閉狀態（不會下次打開就看到彈窗）。 */
  const modalOverlay = document.getElementById("modalOverlay");
  const modalBody = document.getElementById("modalBody");

  function openModal({ title, fields, onSave, initial }) {
    modalBody.innerHTML = `
      <h3>${title}</h3>
      ${fields.map(f => `
        <label class="field-label">${f.label}</label>
        <input class="text-input" type="${f.type}" placeholder="${f.placeholder || ""}" data-field="${f.key}" value="${initial && initial[f.key] !== undefined ? escapeAttr(String(initial[f.key])) : ""}">
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

  function escapeAttr(s) {
    return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function closeModal() {
    modalOverlay.classList.remove("open");
    modalBody.innerHTML = "";
  }

  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  /* ================= 分類關鍵字管理 =================
     系統預設關鍵字（CATEGORIES / INCOME_CATEGORIES 裡寫死的）只顯示、
     不能刪；使用者可以另外新增自己的關鍵字，存在 state 裡、會跟著
     雲端同步，之後遇到判斷不準的情況自己就能修正，不用再等改程式碼。 */
  document.getElementById("manageCategoriesBtn").addEventListener("click", openCategoryManager);

  function openCategoryManager() {
    let kwType = "expense";

    modalBody.innerHTML = `
      <h3>管理分類關鍵字</h3>
      <div class="type-toggle" id="kwType">
        <button type="button" class="type-btn active" data-type="expense">支出分類</button>
        <button type="button" class="type-btn" data-type="income">收入分類</button>
      </div>
      <label class="field-label">選擇分類</label>
      <select id="kwCategorySelect" class="text-input"></select>
      <div class="field-label" style="margin-top:14px;">系統預設關鍵字</div>
      <div class="chip-list" id="kwDefaultChips"></div>
      <div class="field-label" style="margin-top:14px;">我新增的關鍵字</div>
      <div class="chip-list" id="kwCustomChips"></div>
      <div class="row" style="margin-top:10px;">
        <input id="kwNewInput" class="text-input" placeholder="輸入新關鍵字，例如：青菜">
        <button class="add-mini" id="kwAddBtn" style="white-space:nowrap;">新增</button>
      </div>
      <div class="modal-actions">
        <button class="btn-save" id="kwDone" style="flex:1;">完成</button>
      </div>`;
    modalOverlay.classList.add("open");

    const kwTypeToggle = modalBody.querySelector("#kwType");
    const categorySelect = modalBody.querySelector("#kwCategorySelect");
    const defaultChipsEl = modalBody.querySelector("#kwDefaultChips");
    const customChipsEl = modalBody.querySelector("#kwCustomChips");
    const newInput = modalBody.querySelector("#kwNewInput");

    function categoryList() {
      return kwType === "income" ? INCOME_CATEGORIES : CATEGORIES;
    }
    function customStore() {
      return kwType === "income" ? state.incomeCategoryKeywords : state.categoryKeywords;
    }

    function renderCategorySelect() {
      categorySelect.innerHTML = categoryList().map(c => `<option value="${c.key}">${c.key}</option>`).join("");
    }

    function renderChips() {
      const key = categorySelect.value;
      const cat = categoryList().find(c => c.key === key);
      defaultChipsEl.innerHTML = (cat ? cat.keywords : [])
        .map(k => `<span class="chip default">${escapeHtml(k)}</span>`).join("")
        || `<span class="chip-empty">（無）</span>`;

      const custom = (customStore()[key] || []);
      customChipsEl.innerHTML = custom.length
        ? custom.map(k => `<span class="chip">${escapeHtml(k)}<button data-remove-kw="${escapeAttr(k)}">✕</button></span>`).join("")
        : `<span class="chip-empty">還沒有新增自訂關鍵字</span>`;

      customChipsEl.querySelectorAll("[data-remove-kw]").forEach(btn => {
        btn.addEventListener("click", () => {
          const kw = btn.getAttribute("data-remove-kw");
          customStore()[key] = (customStore()[key] || []).filter(k => k !== kw);
          renderChips();
          saveState(state);
        });
      });
    }

    kwTypeToggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".type-btn");
      if (!btn) return;
      kwType = btn.getAttribute("data-type");
      kwTypeToggle.querySelectorAll(".type-btn").forEach(b => b.classList.toggle("active", b === btn));
      renderCategorySelect();
      renderChips();
    });

    categorySelect.addEventListener("change", renderChips);

    modalBody.querySelector("#kwAddBtn").addEventListener("click", () => {
      const kw = newInput.value.trim();
      if (!kw) return;
      const key = categorySelect.value;
      const store = customStore();
      if (!store[key]) store[key] = [];
      if (!store[key].includes(kw)) store[key].push(kw);
      newInput.value = "";
      renderChips();
      saveState(state);
    });

    newInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); modalBody.querySelector("#kwAddBtn").click(); }
    });

    modalBody.querySelector("#kwDone").addEventListener("click", closeModal);

    renderCategorySelect();
    renderChips();
  }

  /* ================= 分頁切換 ================= */
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab}`));
      // 切分頁時捲回最上面，避免停在上個分頁的捲動位置：手機版捲動是在
      // .content 內部（見 style.css 的手機 media query），桌機預覽版
      // 捲動的是整個視窗，兩個都重置才能涵蓋兩種情況。
      const contentEl = document.querySelector(".content");
      if (contentEl) contentEl.scrollTop = 0;
      window.scrollTo({ top: 0, behavior: "instant" });

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
  renderPaymentOptions(paymentSelect, { excludeCards: entryType === "income" });
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
