const state = {
  marketplace: '',
  from: null,
  to: null,
  groupBy: 'day',
  chart: null,
  currentPage: 'overview',
  loadedPages: new Set(),
};

const fmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const fmtMoney = (n) => fmt.format(Math.round(n || 0)) + ' ₸';
const fmtPct = (n) => (n || 0).toFixed(1) + '%';
const mpLabel = (mp) => (mp === 'KASPI' ? 'Kaspi' : mp === 'OZON' ? 'Ozon' : 'WB');

/** Точная дата и время заказа — явно в часовом поясе Алматы (не в часовом
 *  поясе браузера пользователя), чтобы всегда совпадало с тем, что видно
 *  в Kaspi Pay/кабинете, независимо от того, где физически открыт браузер. */
function fmtOrderDateTime(isoDate) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(isoDate));
}

// ВАЖНО: "сегодня"/"N дней назад" всегда считаются по часовому поясу
// Алматы (UTC+5) — явно через Intl API, а не через toISOString() (UTC) или
// локальное время браузера (может отличаться от Алматы). Раньше здесь
// стоял d.toISOString().slice(0,10) — с полуночи до ~5 утра по Алматы это
// возвращало ВЧЕРАШНЮЮ дату вместо сегодняшней (UTC ещё не перевалил за
// полночь), из-за чего "сегодня" в Обзоре могло не совпадать с тем, что
// реально видно в Kaspi Pay.
function todayISO(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Календарная дата "N дней назад" от сегодняшнего дня по Алматы. Считаем
 *  через UTC-арифметику над самой строкой даты (не через локальное время
 *  браузера) — так результат не зависит от часового пояса устройства
 *  пользователя и не может "съехать" на день туда-сюда у полуночи. */
function almatyDateDaysAgo(days, fromDate = new Date()) {
  const todayStr = todayISO(fromDate);
  const [y, m, day] = todayStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() - days);
  return utcDate.toISOString().slice(0, 10);
}

function initDateRange() {
  const toStr = todayISO();
  const fromStr = almatyDateDaysAgo(30);
  document.getElementById('dateTo').value = toStr;
  document.getElementById('dateFrom').value = fromStr;
  state.from = fromStr;
  state.to = toStr;
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.clone().json();
      detail = body?.error ? ` — ${typeof body.error === 'string' ? body.error : JSON.stringify(body.error)}` : '';
      if (body?.details) detail += ` (${body.details})`;
    } catch {
      // тело не JSON — молча пропускаем, оставим базовое сообщение
    }
    throw new Error(`API error ${res.status}: ${path}${detail}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function qs(params) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  return p.toString();
}

// =====================================================================
// Роутинг между страницами (боковое меню)
// =====================================================================
const PAGE_LOADERS = {
  overview: loadOverviewPage,
  orders: loadOrdersPage,
  products: loadProductsPage,
  finance: loadFinancePage,
  reviews: loadReviewsPage,
  mymarket: loadMyMarketPage,
  margin: loadMarginPage,
  niches: loadNichesPage,
  demping: loadDempingPage,
  notifications: loadNotificationsPage,
  settings: loadSettingsPage,
};

function showPage(pageName) {
  if (!PAGE_LOADERS[pageName]) pageName = 'overview';
  state.currentPage = pageName;

  document.querySelectorAll('.page').forEach((el) => {
    el.classList.remove('is-active');
    el.hidden = true;
  });
  const target = document.getElementById(`page-${pageName}`);
  if (target) { target.classList.add('is-active'); target.hidden = false; }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.page === pageName);
  });

  window.location.hash = pageName;

  // Всегда перезагружаем данные страницы при переходе — так фильтры
  // (даты/площадка) наверху всегда отражаются актуально.
  Promise.resolve(PAGE_LOADERS[pageName]()).catch((err) => {
    console.error(`Ошибка загрузки страницы "${pageName}":`, err);
  });
  state.loadedPages.add(pageName);
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

// =====================================================================
// Waterfall (сигнатурный визуальный элемент — раздел «Финансы»)
// =====================================================================
function renderWaterfall(summary) {
  const el = document.getElementById('waterfall');
  if (!el) return;

  // Три карточки — "Прибыль до налога" / "Налог" / "К выводу" — из тех же
  // данных сводки, что и воронка, так что расхождений между ними быть не может.
  const payout = summary.payout ?? summary.netProfit ?? 0;
  const profitBeforeTax = summary.netProfit || 0;
  const taxAmount = summary.taxAmount || 0;

  const profitBeforeTaxEl = document.getElementById('profitBeforeTaxValue');
  if (profitBeforeTaxEl) {
    profitBeforeTaxEl.textContent = fmtMoney(profitBeforeTax);
    profitBeforeTaxEl.style.color = profitBeforeTax >= 0 ? 'var(--text)' : 'var(--loss)';
  }
  const taxLabelEl = document.getElementById('taxCardLabel');
  if (taxLabelEl) taxLabelEl.textContent = `Налог ИП ${summary.taxRatePct ?? 4}%`;
  const taxValueEl = document.getElementById('taxAmountValue');
  if (taxValueEl) taxValueEl.textContent = fmtMoney(taxAmount);

  const cardValueEl = document.getElementById('netProfitCardValue');
  if (cardValueEl) {
    cardValueEl.textContent = fmtMoney(payout);
    cardValueEl.style.color = payout >= 0 ? 'var(--accent)' : 'var(--loss)';
    const card = document.getElementById('netProfitCard');
    card.style.background = payout >= 0
      ? 'linear-gradient(160deg, var(--accent-soft), var(--surface))'
      : 'linear-gradient(160deg, var(--loss-soft), var(--surface))';
    card.style.borderColor = payout >= 0 ? 'rgba(22,163,74,0.35)' : 'rgba(220,38,38,0.35)';
  }

  const revenue = summary.revenue || 0;
  const cogs = summary.cogs || 0;
  const fees = (summary.marketplaceCommission || 0) + (summary.logisticsCost || 0) + (summary.acquiringCost || 0) + (summary.otherFees || 0);
  const ads = (summary.adSpend || 0) + (summary.manualExpenses || 0);
  const tax = summary.taxAmount || 0;
  const finalPayout = summary.payout ?? (summary.netProfit || 0);

  const total = Math.max(revenue, 1);
  const seg = (val) => Math.max((Math.abs(val) / total) * 100, val === 0 ? 0 : 1.2);

  el.innerHTML = `
    <div class="wf-row">
      <div class="wf-seg wf-seg--revenue" style="flex: ${seg(revenue)}"></div>
      <div class="wf-seg wf-seg--cost" style="flex: ${seg(cogs)}"></div>
      <div class="wf-seg wf-seg--cost" style="flex: ${seg(fees)}"></div>
      <div class="wf-seg wf-seg--cost" style="flex: ${seg(ads)}"></div>
      <div class="wf-seg wf-seg--cost" style="flex: ${seg(tax)}"></div>
      <div class="wf-seg wf-seg--profit" style="flex: ${seg(Math.max(finalPayout,0))}"></div>
    </div>
    <div class="wf-labels">
      <span>Выручка ${fmtMoney(revenue)}</span>
      <span>К выводу ${fmtMoney(finalPayout)}</span>
    </div>
    <div class="wf-legend">
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--bg);border:1px solid var(--border)"></span>Выручка</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--loss)"></span>Себестоимость ${fmtMoney(cogs)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--loss)"></span>Комиссии/логистика ${fmtMoney(fees)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--loss)"></span>Реклама и прочее ${fmtMoney(ads)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--loss)"></span>Налог ИП ${fmtMoney(tax)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--accent)"></span>К выводу</div>
    </div>
  `;
}

function kpiCardsHtml(items) {
  return items.map((i) => `
    <div class="kpi-card ${i.accent ? 'kpi-card--accent' : ''}">
      <div class="kpi-card__label">${i.label}</div>
      <div class="kpi-card__value ${i.cls || ''}">${i.value}</div>
    </div>
  `).join('');
}

async function fetchSummary() {
  const summaryResp = await api(`/analytics/summary?${qs({ from: state.from, to: state.to, marketplace: state.marketplace })}`);
  return state.marketplace ? summaryResp : summaryResp.total;
}

// =====================================================================
// ОБЗОР
// =====================================================================
async function loadOverviewPage() {
  const summary = await fetchSummary();

  document.getElementById('overviewKpis').innerHTML = kpiCardsHtml([
    { label: 'Выручка', value: fmtMoney(summary.revenue) },
    { label: 'Прибыль до налога', value: fmtMoney(summary.netProfit), cls: summary.netProfit >= 0 ? 'pos' : 'neg' },
    { label: `Налог ИП ${summary.taxRatePct ?? 4}%`, value: fmtMoney(summary.taxAmount || 0), cls: 'neg' },
    { label: 'К выводу', value: fmtMoney(summary.payout ?? summary.netProfit), cls: (summary.payout ?? summary.netProfit) >= 0 ? 'pos' : 'neg', accent: true },
    { label: 'Маржа', value: fmtPct(summary.marginPct), cls: summary.marginPct >= 0 ? 'pos' : 'neg' },
    { label: 'Заказов', value: fmt.format(summary.ordersCount || 0) },
    { label: 'Средний чек', value: fmtMoney(summary.aov) },
    { label: 'Продано, шт', value: fmt.format(summary.itemsCount || 0) },
  ]);

  await Promise.all([loadTrend(), loadPopularProducts(), loadByCategory()]);
}

async function loadTrend() {
  const canvas = document.getElementById('trendChart');
  if (!canvas) return;

  // Chart.js подключается с CDN отдельным <script> тегом — если сеть
  // подвела именно в этот момент (или скрипт заблокирован расширением),
  // глобальная переменная Chart может быть не определена. Не даём этому
  // уронить всю остальную страницу (и тем более — маскироваться под
  // "ошибку синхронизации", если график перерисовывается сразу после неё).
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js не загрузился — график динамики временно недоступен, остальная страница работает как обычно.');
    return;
  }

  const data = await api(`/analytics/timeseries?${qs({ from: state.from, to: state.to, marketplace: state.marketplace, groupBy: state.groupBy })}`);

  const labels = data.map((d) => d.date);
  const revenue = data.map((d) => d.revenue);
  const profit = data.map((d) => d.profit);

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'line', label: 'Выручка', data: revenue, borderColor: '#9AA1AC', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        { type: 'bar', label: 'Прибыль', data: profit, backgroundColor: profit.map((p) => (p >= 0 ? 'rgba(22,163,74,0.65)' : 'rgba(220,38,38,0.6)')), borderRadius: 3, maxBarThickness: 28 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#6B7280', font: { family: 'Inter', size: 11 } } } },
      scales: {
        x: { ticks: { color: '#9AA1AC', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#EEF0F3' } },
        y: { ticks: { color: '#9AA1AC', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#EEF0F3' } },
      },
    },
  });
}

async function loadPopularProducts() {
  // getByProduct на бэкенде уже отсортирован по прибыли (по убыванию) —
  // здесь просто берём первые 8.
  const data = await api(`/analytics/by-product?${qs({ from: state.from, to: state.to, marketplace: state.marketplace })}`);
  const tbody = document.querySelector('#popularProductsTable tbody');
  const top = data.slice(0, 8);
  if (!top.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--text-faint)">Продаж пока нет</td></tr>`;
    return;
  }
  tbody.innerHTML = top.map((p) => `
    <tr>
      <td class="name-cell">${p.name}</td>
      <td class="num">${fmt.format(p.quantity)}</td>
      <td class="num">${fmtMoney(p.revenue)}</td>
      <td class="num ${p.profit >= 0 ? 'pos' : 'neg'}">${fmtMoney(p.profit)}</td>
    </tr>
  `).join('');
}

async function loadByCategory() {
  const data = await api(`/analytics/by-category?${qs({ from: state.from, to: state.to, marketplace: state.marketplace })}`);
  const tbody = document.querySelector('#byCategoryTable tbody');
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--text-faint)">Продаж пока нет</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((c) => `
    <tr>
      <td class="name-cell">${c.category}</td>
      <td class="num">${fmt.format(c.quantity)}</td>
      <td class="num">${fmtMoney(c.revenue)}</td>
    </tr>
  `).join('');
}

// =====================================================================
// ЗАКАЗЫ
// =====================================================================
let ordersFiltersWired = false;
let selectedOrderIds = new Set();

function wireOrdersFiltersOnce() {
  if (ordersFiltersWired) return;
  ordersFiltersWired = true;

  document.querySelectorAll('#ordersFilters input, #ordersFilters select').forEach((el) => {
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    let debounceTimer;
    el.addEventListener(evt, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadOrders, 300);
    });
  });

  document.getElementById('statusTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#statusTabs button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    selectedOrderIds.clear();
    loadOrders();
  });

  document.getElementById('ordersSelectAll').addEventListener('change', (e) => {
    document.querySelectorAll('#ordersTable tbody input[type="checkbox"][data-order-id]').forEach((cb) => {
      cb.checked = e.target.checked;
      if (e.target.checked) selectedOrderIds.add(cb.dataset.orderId);
      else selectedOrderIds.delete(cb.dataset.orderId);
    });
    updateOrdersSelectedCount();
  });

  document.getElementById('bulkWaybillBtn').addEventListener('click', async () => {
    if (!selectedOrderIds.size) { alert('Сначала выбери заказы (чекбоксы слева от номера)'); return; }
    if (!confirm(`Сформировать накладные для ${selectedOrderIds.size} заказ(ов)? Заявки уйдут в кабинет Kaspi.`)) return;
    const btn = document.getElementById('bulkWaybillBtn');
    btn.textContent = '…'; btn.disabled = true;
    try {
      const res = await api('/orders/bulk-waybill', { method: 'POST', body: JSON.stringify({ ids: Array.from(selectedOrderIds) }) });
      alert(`Готово: успешно ${res.succeeded}, с ошибкой ${res.failed}.` + (res.failed ? '\n' + res.results.filter((r) => !r.ok).map((r) => r.error).join('\n') : ''));
      selectedOrderIds.clear();
      await loadOrders();
    } catch (err) {
      alert('Ошибка: ' + err.message);
    } finally {
      btn.textContent = '📄 Сформировать накладные'; btn.disabled = false;
    }
  });

  document.getElementById('printWaybillsBtn').addEventListener('click', () => {
    if (!selectedOrderIds.size) { alert('Сначала выбери заказы (чекбоксы слева от номера)'); return; }
    window.open(`/api/orders/print/waybills?ids=${Array.from(selectedOrderIds).join(',')}`, '_blank');
  });
}

function updateOrdersSelectedCount() {
  document.getElementById('ordersSelectedCount').textContent = `Выбрано: ${selectedOrderIds.size}`;
}

async function loadOrdersPage() {
  wireOrdersFiltersOnce();
  await loadOrdersMeta();
  await loadOrders();
}

async function loadOrdersMeta() {
  const meta = await api('/orders/meta');
  const citySelect = document.querySelector('#ordersFilters select[name="city"]');
  const deliverySelect = document.querySelector('#ordersFilters select[name="deliveryType"]');
  if (!citySelect.dataset.loaded) {
    meta.cities.forEach((c) => {
      const opt = document.createElement('option'); opt.value = c; opt.textContent = c;
      citySelect.appendChild(opt);
    });
    citySelect.dataset.loaded = '1';
  }
  if (!deliverySelect.dataset.loaded) {
    meta.deliveryTypes.forEach((d) => {
      const opt = document.createElement('option'); opt.value = d; opt.textContent = d;
      deliverySelect.appendChild(opt);
    });
    deliverySelect.dataset.loaded = '1';
  }
}

async function loadOrders() {
  const filters = new FormData(document.getElementById('ordersFilters'));
  const statusGroup = document.querySelector('#statusTabs button.is-active')?.dataset.status || '';
  const res = await api(`/orders?${qs({
    from: state.from, to: state.to, marketplace: state.marketplace, pageSize: 20,
    search: filters.get('search'), city: filters.get('city'), deliveryType: filters.get('deliveryType'), statusGroup,
  })}`);
  const tbody = document.querySelector('#ordersTable tbody');
  document.getElementById('ordersSelectAll').checked = false;
  if (!res.orders.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-faint)">Нет заказов за период</td></tr>`;
    updateOrdersSelectedCount();
    return;
  }
  tbody.innerHTML = res.orders.map((o) => `
    <tr>
      <td><input type="checkbox" data-order-id="${o.id}" ${selectedOrderIds.has(o.id) ? 'checked' : ''} /></td>
      <td>${o.externalId}</td>
      <td><span class="mp-tag"><i class="dot dot--${o.marketplace.toLowerCase()}"></i>${mpLabel(o.marketplace)}</span></td>
      <td>${fmtOrderDateTime(o.orderDate)}</td>
      <td>${o.status}</td>
      <td class="num">${fmtMoney(o.totalRevenue)}</td>
      <td>${orderActionCell(o)}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('input[type="checkbox"][data-order-id]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedOrderIds.add(cb.dataset.orderId);
      else selectedOrderIds.delete(cb.dataset.orderId);
      updateOrdersSelectedCount();
    });
  });
  updateOrdersSelectedCount();

  tbody.querySelectorAll('button[data-action="accept-order"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.textContent = '…'; btn.disabled = true;
      try {
        await api(`/orders/${btn.dataset.id}/accept`, { method: 'POST' });
        loadOrders();
      } catch (err) {
        alert('Ошибка: ' + err.message);
        btn.textContent = 'Принять'; btn.disabled = false;
      }
    });
  });
  tbody.querySelectorAll('button[data-action="form-waybill"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = btn.parentElement.querySelector('input[name="numberOfSpace"]');
      const numberOfSpace = Number(input.value) || 1;
      btn.textContent = '…'; btn.disabled = true;
      try {
        await api(`/orders/${btn.dataset.id}/waybill`, { method: 'POST', body: JSON.stringify({ numberOfSpace }) });
        loadOrders();
      } catch (err) {
        alert('Ошибка: ' + err.message);
        btn.textContent = 'Накладная'; btn.disabled = false;
      }
    });
  });
}

function orderActionCell(o) {
  if (o.marketplace !== 'KASPI') return '—';
  if (o.status === 'NEW') {
    return `<button class="btn btn--ghost" style="padding:4px 8px;font-size:11px" data-action="accept-order" data-id="${o.id}">Принять</button>`;
  }
  if (o.status === 'ACCEPTED_BY_MERCHANT') {
    return `
      <div style="display:flex;gap:4px;align-items:center">
        <input name="numberOfSpace" type="number" min="1" value="${o.numberOfSpace ?? 1}" class="cost-input" style="width:50px" />
        <button class="btn btn--ghost" style="padding:4px 8px;font-size:11px" data-action="form-waybill" data-id="${o.id}">Накладная</button>
      </div>`;
  }
  if (o.status === 'ASSEMBLE') return `<span style="color:var(--accent);font-size:12px">✓ Накладная сформирована</span>`;
  return '—';
}

// =====================================================================
// ТОВАРЫ
// =====================================================================
let productsFormWired = false;
let allProductsCache = [];
let kaspiRatesCache = null; // { "Категория": 12.5, ... } — плоский список название->ставка, для существующих select'ов и валидации файла
let kaspiCategoryOptionsCache = null; // [{name, ratePct, level}] — ПОЛНЫЙ список (top+leaf), для поиска в таблице «Товары»
let productsForecastCache = new Map(); // "productId:MARKETPLACE" -> прогноз "если продать по текущей цене сейчас" (см. getProductForecasts)
let selectedProductIds = new Set(); // выбранные чекбоксами товары — сохраняется между страницами пагинации, сбрасывается при смене фильтра/площадки
let productsCurrentPage = 1;
const PRODUCTS_PAGE_SIZE = 15;

async function loadKaspiCategoriesIntoSelect(selectEl) {
  const categories = await api('/products/kaspi-categories');
  if (!kaspiCategoryOptionsCache) kaspiCategoryOptionsCache = categories;
  if (!kaspiRatesCache) {
    kaspiRatesCache = {};
    categories.forEach((c) => { kaspiRatesCache[c.name] = c.ratePct; });
  }
  if (!selectEl || selectEl.dataset.loaded) return;
  categories
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = `${c.name} (${c.ratePct}%)`;
      selectEl.appendChild(opt);
    });
  selectEl.dataset.loaded = '1';
}

/** По введённому названию находит точную запись в справочнике категорий
 *  (с уровнем top/leaf) — используется, чтобы понять, в какое поле товара
 *  сохранять выбор (kaspiTopCategory для верхнего уровня, kaspiLeafCategory
 *  для точной подкатегории). */
function findKaspiCategoryOption(name) {
  if (!kaspiCategoryOptionsCache) return null;
  return kaspiCategoryOptionsCache.find((c) => c.name === name) || null;
}

function wireProductsFormOnce() {
  if (productsFormWired) return;
  productsFormWired = true;

  document.getElementById('productForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      sku: fd.get('sku'),
      name: fd.get('name'),
      costPrice: Number(fd.get('costPrice')),
      weightKg: Number(fd.get('weightKg')) || 0.5,
      kaspiSku: fd.get('kaspiSku') || null,
      kaspiTopCategory: fd.get('kaspiTopCategory') || null,
      kaspiLeafCategory: fd.get('kaspiLeafCategory') || null,
      ozonOfferId: fd.get('ozonOfferId') || null,
      wbArticle: fd.get('wbArticle') || null,
    };
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    try {
      await api('/products', { method: 'POST', body: JSON.stringify(payload) });
      e.target.reset();
      await loadProductsAdminTable();
    } catch (err) {
      alert('Не удалось добавить товар: ' + err.message);
    } finally {
      btn.textContent = originalText; btn.disabled = false;
    }
  });

  document.getElementById('productStatusTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#productStatusTabs button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    productsCurrentPage = 1;
    selectedProductIds.clear();
    renderProductsAdminTable();
  });

  document.getElementById('bulkCategoryBtn').addEventListener('click', (e) => {
    if (!selectedProductIds.size) { alert('Сначала выбери товары (чекбоксы слева)'); return; }
    const btn = document.getElementById('bulkCategoryBtn');
    openCategoryPicker(btn, async (categoryName) => {
      btn.disabled = true;
      try {
        const res = await api('/products/bulk-set-category', { method: 'POST', body: JSON.stringify({ ids: Array.from(selectedProductIds), categoryName }) });
        alert(`Категория «${categoryName}» проставлена: ${res.updated} товар(ов).`);
        await loadProductsAdminTable();
      } catch (err) {
        alert('Не удалось проставить категорию: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.getElementById('productsArchiveBtn').addEventListener('click', async () => {
    if (!selectedProductIds.size) { alert('Сначала выбери товары (чекбоксы слева)'); return; }
    if (!confirm(`Снять с продажи (в архив) ${selectedProductIds.size} товар(ов)?`)) return;
    const btn = document.getElementById('productsArchiveBtn');
    btn.disabled = true;
    try {
      const res = await api('/products/bulk-archive', { method: 'POST', body: JSON.stringify({ ids: Array.from(selectedProductIds) }) });
      alert(`Отправлено в архив: ${res.archived}.`);
      selectedProductIds.clear();
      await loadProductsAdminTable();
    } catch (err) {
      alert('Не удалось архивировать: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('productsDeleteBtn').addEventListener('click', async () => {
    if (!selectedProductIds.size) { alert('Сначала выбери товары (чекбоксы слева)'); return; }
    if (!confirm(`Удалить безвозвратно ${selectedProductIds.size} товар(ов)? Это действие нельзя отменить.`)) return;
    const btn = document.getElementById('productsDeleteBtn');
    btn.disabled = true;
    try {
      const res = await api('/products/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: Array.from(selectedProductIds) }) });
      alert(`Удалено: ${res.deleted}.`);
      selectedProductIds.clear();
      await loadProductsAdminTable();
    } catch (err) {
      alert('Не удалось удалить: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('bulkCostPriceBtn').addEventListener('click', async () => {
    const input = document.getElementById('bulkCostPriceInput');
    const value = Number(input.value);
    if (!value || value <= 0) { alert('Укажи положительную себестоимость'); return; }
    if (!confirm(`Проставить себестоимость ${value} ₸ всем товарам, у которых сейчас 0?`)) return;
    const btn = document.getElementById('bulkCostPriceBtn');
    btn.textContent = '…'; btn.disabled = true;
    try {
      const res = await api('/products/bulk-set-cost-price', { method: 'POST', body: JSON.stringify({ costPrice: value }) });
      alert(`Обновлено товаров: ${res.updated}.`);
      input.value = '';
      await loadProductsAdminTable();
    } catch (err) {
      alert('Ошибка: ' + err.message);
    } finally {
      btn.textContent = 'Проставить всем с себестоимостью 0'; btn.disabled = false;
    }
  });

  document.getElementById('syncCatalogBtn').addEventListener('click', async () => {
    const btn = document.getElementById('syncCatalogBtn');
    const days = Number(document.getElementById('kaspiSyncDays').value) || 7;
    btn.textContent = '…'; btn.disabled = true;
    try {
      const res = await runChunkedKaspiSync(days);
      alert(`Синхронизировано заказов: ${res.ordersProcessed}. Создано товаров: ${res.productsCreated}.`);
      try {
        await loadProductsAdminTable();
      } catch (renderErr) {
        console.warn('Синхронизация прошла успешно, но при обновлении таблицы возникла ошибка:', renderErr);
      }
    } catch (err) {
      alert('Ошибка синхронизации: ' + err.message);
    } finally {
      btn.textContent = '↻ Каталог Kaspi (из заказов)'; btn.disabled = false;
    }
  });

  document.getElementById('syncOzonCatalogBtn').addEventListener('click', async () => {
    const btn = document.getElementById('syncOzonCatalogBtn');
    btn.textContent = '…'; btn.disabled = true;
    try {
      const res = await api('/sync/ozon-catalog', { method: 'POST' });
      alert(`Каталог Ozon синхронизирован. Создано товаров: ${res.created}. Обновлено: ${res.updated}.`);
      try {
        await loadProductsAdminTable();
      } catch (renderErr) {
        console.warn('Синхронизация прошла успешно, но при обновлении таблицы возникла ошибка:', renderErr);
      }
    } catch (err) {
      alert('Ошибка синхронизации каталога Ozon: ' + err.message);
    } finally {
      btn.textContent = '↻ Каталог Ozon'; btn.disabled = false;
    }
  });

  document.getElementById('syncWbCatalogBtn').addEventListener('click', async () => {
    const btn = document.getElementById('syncWbCatalogBtn');
    btn.textContent = '…'; btn.disabled = true;
    try {
      const res = await api('/sync/wb-catalog', { method: 'POST' });
      // Явно показываем диагностику цен — раньше при сбое получения цен
      // (например, у токена нет категории доступа "Цены и скидки") ошибка
      // тихо терялась в логах сервера, и было видно только "обновлено N",
      // без объяснения, почему цена/комиссия всё равно пустые.
      let msg = `Каталог WB синхронизирован. Создано товаров: ${res.created}. Обновлено: ${res.updated}.`;
      if (res.priceError) {
        msg += `\n\n⚠ Цены получить не удалось: ${res.priceError}\nПроверь, что токен WB создан с категорией доступа «Цены и скидки».`;
      } else {
        msg += ` Цены получены: ${res.pricesFetched}.`;
      }
      if (res.subjectMissingCount > 0) {
        msg += `\n⚠ У ${res.subjectMissingCount} товаров WB не прислал "предмет" — для них комиссия останется "—", пока предмет не появится (обычно подтягивается из данных заказа).`;
      }
      alert(msg);
      try {
        await loadProductsAdminTable();
      } catch (renderErr) {
        console.warn('Синхронизация прошла успешно, но при обновлении таблицы возникла ошибка:', renderErr);
      }
    } catch (err) {
      alert('Ошибка синхронизации каталога WB: ' + err.message);
    } finally {
      btn.textContent = '↻ Каталог WB'; btn.disabled = false;
    }
  });

  document.getElementById('bulkUploadBtn').addEventListener('click', handleBulkUpload);
}

// =====================================================================
// Разбиение синхронизации Kaspi на маленькие последовательные куски —
// вместо одного большого запроса (который на serverless легко упирается
// в лимит времени), запрашиваем по SYNC_CHUNK_DAYS дней за раз, показывая
// прогресс, пока не покроем весь запрошенный период.
// =====================================================================
const SYNC_CHUNK_DAYS = 7;

function showSyncProgress(text) {
  const banner = document.getElementById('syncProgressBanner');
  banner.hidden = false;
  banner.textContent = text;
}
function hideSyncProgress() {
  document.getElementById('syncProgressBanner').hidden = true;
}

/**
 * Синхронизирует Kaspi за totalDays дней, разбивая на куски по
 * SYNC_CHUNK_DAYS дней и вызывая /api/sync/kaspi по очереди для каждого
 * куска. Показывает прогресс, суммирует результат по всем кускам.
 * Останавливается при первой ошибке (но сохранённое в БД за предыдущие
 * успешные куски никуда не пропадает).
 */
async function runChunkedKaspiSync(totalDays) {
  const chunks = [];
  const now = new Date();
  for (let daysAgoEnd = totalDays; daysAgoEnd > 0; daysAgoEnd -= SYNC_CHUNK_DAYS) {
    const daysAgoStart = Math.max(daysAgoEnd - SYNC_CHUNK_DAYS, 0);
    const to = new Date(now.getTime() - daysAgoStart * 24 * 60 * 60 * 1000);
    const from = new Date(now.getTime() - daysAgoEnd * 24 * 60 * 60 * 1000);
    chunks.push({ from, to });
  }

  let ordersProcessed = 0;
  let productsCreated = 0;

  try {
    for (let i = 0; i < chunks.length; i++) {
      const { from, to } = chunks[i];
      showSyncProgress(
        `⏳ Синхронизация Kaspi… кусок ${i + 1} из ${chunks.length} ` +
          `(${from.toLocaleDateString('ru-RU')}–${to.toLocaleDateString('ru-RU')}). Не закрывайте страницу.`,
      );
      const res = await api(`/sync/kaspi?${qs({ from: from.toISOString(), to: to.toISOString() })}`, { method: 'POST' });
      ordersProcessed += res.ordersProcessed ?? 0;
      productsCreated += res.productsCreated ?? 0;
    }
  } finally {
    hideSyncProgress();
  }

  return { ordersProcessed, productsCreated };
}


/**
 * Массовая загрузка товаров из Excel/CSV. Файл целиком разбирается в
 * браузере (PapaParse для CSV, SheetJS для Excel), затем отправляется на
 * сервер ПАЧКАМИ по 150 строк за раз — это специально сделано так, чтобы
 * ни один отдельный запрос не упирался в таймаут serverless-функции, даже
 * если файл на тысячи строк.
 */
let bulkUploadPreviewState = null; // { newRows, duplicateRows } — между показом предпросмотра и нажатием одной из кнопок

async function handleBulkUpload() {
  const fileInput = document.getElementById('bulkUploadFile');
  const file = fileInput.files[0];
  const progressEl = document.getElementById('bulkUploadProgress');
  const btn = document.getElementById('bulkUploadBtn');

  if (!file) { alert('Сначала выбери файл'); return; }

  progressEl.innerHTML = `<p style="color:var(--text-faint);font-size:12.5px">Читаю файл…</p>`;
  btn.disabled = true;

  try {
    const parsed = await parseSpreadsheetFile(file);
    const rows = parsed.rows;
    if (!rows.length) {
      // Показываем ТОЧНО, чего не хватает — раньше писали одинаковый текст
      // "не хватает SKU/Название" независимо от того, что реально нашлось,
      // это вводило в заблуждение, если один из двух на самом деле был найден.
      const d = parsed.diagnostic ?? { foundHeaders: [], hasSku: false, hasName: false };
      const missing = [];
      if (!d.hasSku) missing.push('SKU');
      if (!d.hasName) missing.push('Название');
      const foundText = d.foundHeaders.length
        ? `Нашёл колонки: ${d.foundHeaders.join(', ')}. ${missing.length ? `Не хватает: ${missing.join(', ')}.` : ''}`
        : `В первых ${BULK_UPLOAD_MAX_HEADER_ROWS} строках ни одного листа не нашёл вообще ни одной узнаваемой колонки.`;
      progressEl.innerHTML = `<p style="color:var(--loss);font-size:12.5px">
        Не удалось найти шапку с колонками SKU и Название среди первых ${BULK_UPLOAD_MAX_HEADER_ROWS} строк
        (проверены все листы файла). ${foundText}<br>
        Нужна колонка с артикулом (sku / Артикул / Код / Код товара / vendorCode / Артикул продавца / Артикул товара /
        Артикул на витрине / SKU продавца / Код продавца / Merchant SKU / nmId / Баркод / Штрихкод)
        и колонка с названием (name / Название / Наименование / Товар / Название товара / Название на витрине /
        Название модели / Модель / model / Product name / Title).
      </p>`;
      return;
    }

    // ВАЖНО: файл больше НЕ пишется в базу сразу — сначала показываем
    // предпросмотр (что новое, что уже есть), и ждём явного решения
    // пользователя (одна из двух кнопок ниже). Сверяем и по sku, и по
    // kaspiSku — товар может уже существовать под тем же артикулом Kaspi,
    // даже если внутренний SKU в файле отличается.
    progressEl.innerHTML = `<p style="color:var(--text-faint);font-size:12.5px">Сверяю с уже существующими товарами…</p>`;
    const existingProducts = await api('/products');
    const existingBySku = new Map(existingProducts.map((p) => [p.sku, p]));
    const existingByKaspiSku = new Map(existingProducts.filter((p) => p.kaspiSku).map((p) => [p.kaspiSku, p]));

    const duplicateRows = [];
    const newRows = [];
    for (const row of rows) {
      const existing = existingBySku.get(row.sku) || (row.kaspiSku ? existingByKaspiSku.get(row.kaspiSku) : null);
      if (existing) duplicateRows.push({ row, existing });
      else newRows.push(row);
    }

    bulkUploadPreviewState = { newRows, duplicateRows };
    renderBulkUploadPreview(rows.length, newRows, duplicateRows);
  } catch (err) {
    progressEl.innerHTML = `<p style="color:var(--loss);font-size:12.5px">Ошибка: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function renderBulkUploadPreview(totalCount, newRows, duplicateRows) {
  const progressEl = document.getElementById('bulkUploadProgress');

  const newRowsHtml = newRows.length
    ? newRows.slice(0, 300).map((r) => `<tr><td class="name-cell">${r.sku}</td><td class="name-cell">${r.name}</td></tr>`).join('')
    : `<tr><td colspan="2" style="color:var(--text-faint)">Нет новых товаров</td></tr>`;

  const duplicatesHtml = duplicateRows.length
    ? duplicateRows.slice(0, 300).map(({ row, existing }) => `
        <tr>
          <td class="name-cell">${row.sku}</td>
          <td class="name-cell">${row.name}</td>
          <td class="name-cell" style="font-size:11px;color:var(--text-faint)">
            ${existing.name !== row.name ? `название: «${existing.name}» → «${row.name}»` : ''}
            ${existing.costPrice !== row.costPrice ? `${existing.name !== row.name ? '; ' : ''}себестоимость: ${existing.costPrice} → ${row.costPrice}` : ''}
            ${(existing.name === row.name && existing.costPrice === row.costPrice) ? 'без изменений' : ''}
          </td>
        </tr>
      `).join('')
    : `<tr><td colspan="3" style="color:var(--text-faint)">Совпадений не найдено</td></tr>`;

  progressEl.innerHTML = `
    <div class="panel" style="margin:12px 0;background:var(--bg)">
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px;font-size:13px">
        <span>Всего в файле: <strong>${totalCount}</strong></span>
        <span style="color:var(--warn)">Повторы: <strong>${duplicateRows.length}</strong></span>
        <span style="color:var(--accent)">Новых: <strong>${newRows.length}</strong></span>
      </div>

      <div style="display:flex;gap:10px;margin-bottom:16px">
        <button class="btn btn--accent" id="bulkUploadConfirmNewBtn">Загрузить только новые (${newRows.length})</button>
        <button class="btn btn--ghost" id="bulkUploadConfirmAllBtn">Обновить повторы тоже (${totalCount})</button>
      </div>

      <div style="font-size:12.5px;font-weight:600;margin-bottom:6px">🆕 Новые, которых нет в каталоге (${newRows.length})</div>
      <div class="table-wrap" style="max-height:220px;overflow-y:auto;margin-bottom:16px">
        <table class="table"><thead><tr><th>SKU</th><th>Название</th></tr></thead><tbody>${newRowsHtml}</tbody></table>
      </div>

      <div style="font-size:12.5px;font-weight:600;margin-bottom:6px">🔁 Уже есть в каталоге — повторы (${duplicateRows.length})</div>
      <div class="table-wrap" style="max-height:220px;overflow-y:auto">
        <table class="table"><thead><tr><th>SKU</th><th>Название (из файла)</th><th>Что изменится при обновлении</th></tr></thead><tbody>${duplicatesHtml}</tbody></table>
      </div>
      ${(newRows.length > 300 || duplicateRows.length > 300) ? `<p class="panel__hint">Показаны первые 300 строк каждого списка — при загрузке обработаются все.</p>` : ''}
    </div>
  `;

  document.getElementById('bulkUploadConfirmNewBtn').addEventListener('click', () => runBulkUpload(bulkUploadPreviewState.newRows));
  document.getElementById('bulkUploadConfirmAllBtn').addEventListener('click', () => {
    if (!confirm(`Обновить ${bulkUploadPreviewState.duplicateRows.length} уже существующих товаров данными из файла?`)) return;
    runBulkUpload([...bulkUploadPreviewState.newRows, ...bulkUploadPreviewState.duplicateRows.map((d) => d.row)]);
  });
}

async function runBulkUpload(rowsToUpload) {
  const fileInput = document.getElementById('bulkUploadFile');
  const progressEl = document.getElementById('bulkUploadProgress');

  if (!rowsToUpload.length) {
    progressEl.innerHTML = `<p style="color:var(--text-faint);font-size:12.5px">Нечего загружать — список пуст.</p>`;
    return;
  }

  try {
    const CHUNK = 150;
    let created = 0, updated = 0;
    const allErrors = [];

    for (let i = 0; i < rowsToUpload.length; i += CHUNK) {
      const chunk = rowsToUpload.slice(i, i + CHUNK);
      progressEl.innerHTML = `<p style="color:var(--text-muted);font-size:12.5px">Загружено ${i} из ${rowsToUpload.length}…</p>`;
      const res = await api('/products/bulk-upsert', { method: 'POST', body: JSON.stringify({ products: chunk }) });
      created += res.created;
      updated += res.updated;
      allErrors.push(...res.errors);
    }

    progressEl.innerHTML = `
      <p style="color:var(--accent);font-size:12.5px">
        Готово: создано ${created}, обновлено ${updated} из ${rowsToUpload.length}.
        ${allErrors.length ? `Ошибок: ${allErrors.length} (первые: ${allErrors.slice(0, 5).join('; ')})` : ''}
      </p>`;
    fileInput.value = '';
    bulkUploadPreviewState = null;
    await loadProductsAdminTable();
  } catch (err) {
    progressEl.innerHTML = `<p style="color:var(--loss);font-size:12.5px">Ошибка: ${err.message}</p>`;
  }
}

/**
 * Псевдонимы колонок — сопоставляем любой из этих вариантов заголовка
 * (регистр и пробелы не важны) с нужным полем товара. Так принимаем файл
 * "как есть" — например, выгрузку из кабинета Kaspi с русскими заголовками,
 * а не только англоязычный формат sku/name.
 */
const BULK_UPLOAD_COLUMN_ALIASES = {
  sku: [
    'sku', 'артикул', 'код', 'код товара', 'vendorcode', 'артикул продавца',
    'артикул товара', 'артикул на витрине', 'sku продавца', 'код продавца',
    'merchant sku', 'nmid', 'баркод', 'штрихкод',
  ],
  name: [
    'name', 'название', 'наименование', 'товар', 'название товара', 'title', 'productname',
    'название на витрине', 'название модели', 'модель', 'product name',
    'model', // англ. "модель" без приставки — так называется колонка в выгрузке Kaspi (ACTIVE.xlsx)
  ],
  kaspiSku: ['kaspisku', 'артикул kaspi', 'артикул магазина'],
  costPrice: ['costprice', 'себестоимость', 'закуп', 'цена закупки', 'закупочная цена'],
  kaspiTopCategory: ['kaspitopcategory', 'категория', 'категория kaspi'],
  // Цена витрины — используется как referencePrice для прогноза Kaspi,
  // если у товара ещё нет цены из реальной продажи (см. ACTIVE.xlsx: price).
  kaspiReferencePrice: ['price', 'цена', 'цена витрины'],
};

const BULK_UPLOAD_MAX_HEADER_ROWS = 30;

/**
 * Ищет строку-шапку среди первых maxRows строк (не только в первой — в
 * реальных выгрузках перед заголовком часто есть титульные/пустые строки)
 * — строка считается шапкой, если среди её ячеек находится хотя бы один
 * псевдоним SKU И хотя бы один псевдоним названия.
 * Возвращает { headerRowIndex, columnIndex, rawHeaders } или null, если не нашли.
 * rawHeaders — исходные (не нормализованные) непустые ячейки строки с
 * наибольшим числом узнанных колонок — нужны для диагностики, если шапку
 * найти не удалось нигде (см. findBulkUploadHeaderAnywhere).
 */
function scanRowsForHeader(aoa, maxRows) {
  let bestCandidate = null; // строка с максимальным числом узнанных (но не обязательно полным набором) колонок
  for (let r = 0; r < Math.min(maxRows, aoa.length); r++) {
    const row = aoa[r] || [];
    const normalizedCells = row.map((cell) => String(cell ?? '').trim().toLowerCase());

    const columnIndex = {};
    for (const [field, aliases] of Object.entries(BULK_UPLOAD_COLUMN_ALIASES)) {
      const idx = normalizedCells.findIndex((cell) => aliases.includes(cell));
      if (idx !== -1) columnIndex[field] = idx;
    }

    const matchedFields = Object.keys(columnIndex);
    const rawHeaders = row.map((c) => String(c ?? '').trim()).filter(Boolean);

    if (columnIndex.sku !== undefined && columnIndex.name !== undefined) {
      return { headerRowIndex: r, columnIndex, rawHeaders };
    }
    if (matchedFields.length > 0 && (!bestCandidate || matchedFields.length > bestCandidate.matchedFields.length)) {
      bestCandidate = { matchedFields, rawHeaders, hasSku: columnIndex.sku !== undefined, hasName: columnIndex.name !== undefined };
    }
  }
  return { headerRowIndex: -1, columnIndex: null, bestCandidate };
}

/** Превращает "сырые" строки (массив массивов, как есть в файле) в массив
 *  товаров для bulk-upsert, используя найденную шапку. */
function extractRowsUsingHeader(aoa, headerRowIndex, columnIndex) {
  const rows = [];
  for (let r = headerRowIndex + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const sku = String(row[columnIndex.sku] ?? '').trim();
    const name = String(row[columnIndex.name] ?? '').trim();
    if (!sku || !name) continue; // лишние/пустые строки — пропускаем, не выдумываем данные

    // kaspiSku: если отдельной колонки "Артикул Kaspi" нет — используем ту
    // же колонку SKU (так в выгрузке Kaspi ACTIVE.xlsx: там один и тот же
    // артикул и служит внутренним SKU, и является артикулом Kaspi).
    const kaspiSku = columnIndex.kaspiSku !== undefined
      ? (String(row[columnIndex.kaspiSku] ?? '').trim() || null)
      : sku;

    const priceRaw = columnIndex.kaspiReferencePrice !== undefined
      ? Number(String(row[columnIndex.kaspiReferencePrice] ?? '').replace(',', '.'))
      : null;

    rows.push({
      sku,
      name,
      kaspiSku,
      costPrice: columnIndex.costPrice !== undefined ? (Number(String(row[columnIndex.costPrice] ?? '').replace(',', '.')) || 0) : 0,
      kaspiTopCategory: columnIndex.kaspiTopCategory !== undefined ? (String(row[columnIndex.kaspiTopCategory] ?? '').trim() || null) : null,
      kaspiReferencePrice: priceRaw && priceRaw > 0 ? priceRaw : null,
    });
  }
  return rows;
}

/**
 * Ищет шапку по ВСЕМ листам (sheets) файла — не только по первому, у
 * некоторых выгрузок данные лежат на втором/третьем листе. Возвращает
 * либо { rows }, либо { rows: [], diagnostic: { foundHeaders } } с тем,
 * что реально нашли (лучший кандидат среди всех просмотренных строк/листов),
 * чтобы показать пользователю точную причину вместо немой ошибки.
 */
function findBulkUploadHeaderAnywhere(sheetsAoa) {
  let bestDiagnostic = null;
  for (const aoa of sheetsAoa) {
    const found = scanRowsForHeader(aoa, BULK_UPLOAD_MAX_HEADER_ROWS);
    if (found.headerRowIndex !== -1) {
      return { rows: extractRowsUsingHeader(aoa, found.headerRowIndex, found.columnIndex) };
    }
    if (found.bestCandidate && (!bestDiagnostic || found.bestCandidate.matchedFields.length > bestDiagnostic.matchedFields.length)) {
      bestDiagnostic = found.bestCandidate;
    }
  }
  return {
    rows: [],
    diagnostic: {
      foundHeaders: bestDiagnostic ? bestDiagnostic.rawHeaders : [],
      hasSku: bestDiagnostic ? bestDiagnostic.hasSku : false,
      hasName: bestDiagnostic ? bestDiagnostic.hasName : false,
    },
  };
}

/** Разбирает CSV (PapaParse) или Excel (SheetJS, ВСЕ листы) в массив строк
 *  для bulk-upsert. Возвращает { rows, diagnostic? }. */
function parseSpreadsheetFile(file) {
  return new Promise((resolve, reject) => {
    const isExcel = /\.xlsx?$/i.test(file.name);

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          // Смотрим ВСЕ листы, не только первый — шапка может быть на любом.
          const sheetsAoa = wb.SheetNames.map((name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }));
          resolve(findBulkUploadHeaderAnywhere(sheetsAoa));
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      reader.readAsArrayBuffer(file);
    } else {
      Papa.parse(file, {
        header: false, // без заголовка — ищем шапку сами среди первых строк
        skipEmptyLines: true,
        complete: (res) => resolve(findBulkUploadHeaderAnywhere([res.data])), // у CSV один "лист"
        error: (err) => reject(err),
      });
    }
  });
}

async function loadProductsPage() {
  wireProductsFormOnce();
  await loadKaspiCategoriesIntoSelect(document.getElementById('kaspiTopCategorySelect'));
  await loadProductsAdminTable();
}

async function loadProductsAdminTable() {
  const [products, forecasts] = await Promise.all([
    api('/products'),
    api('/analytics/forecast'),
  ]);
  allProductsCache = products;
  // Прогноз теперь ПО ПЛОЩАДКЕ: ключ "productId:MARKETPLACE" -> запись прогноза.
  productsForecastCache = new Map(forecasts.map((f) => [`${f.productId}:${f.marketplace}`, f]));
  renderProductsAdminTable();
}

function priceFieldName(marketplace) {
  return marketplace === 'KASPI' ? 'kaspiReferencePrice' : marketplace === 'OZON' ? 'ozonReferencePrice' : 'wbReferencePrice';
}

function isLinkedToMarketplace(p, marketplace) {
  return marketplace === 'KASPI' ? !!p.kaspiSku : marketplace === 'OZON' ? !!p.ozonOfferId : !!p.wbArticle;
}

/**
 * Цена — теперь РЕДАКТИРУЕМОЕ поле. Kaspi (как и большинство площадок) не
 * даёт узнать текущую цену товара, пока по нему не было продажи, а нужно
 * видеть прогноз прибыли ДО того, как товар вообще выставлен на продажу —
 * поэтому цену для прогноза можно просто вписать вручную, как и себестоимость.
 */
function renderForecastCells(p, marketplace) {
  const colsForMp = marketplace === 'WB' ? 7 : 6;
  if (!isLinkedToMarketplace(p, marketplace)) {
    // Товар вообще не привязан к этой площадке (нет артикула) — редактировать нечего.
    return `<td class="num" style="border-left:2px solid var(--border);color:var(--text-faint)">—</td>` + '<td class="num">—</td>'.repeat(colsForMp - 1);
  }
  const fc = productsForecastCache.get(`${p.id}:${marketplace}`);
  const badge = (fc?.source === 'historical-average' || fc?.source === 'kaspi-tariff-default')
    ? ` <span style="color:var(--text-faint);font-size:10px" title="${fc.source === 'kaspi-tariff-default' ? 'Категория неизвестна — применена усреднённая ставка комиссии Kaspi (12.5%), укажи категорию для точного расчёта' : `Оценка по средней ставке из прошлых продаж этого товара на ${mpLabel(marketplace)}`}">≈</span>`
    : '';
  const priceValue = fc?.referencePrice != null ? fc.referencePrice : '';
  // "Возврат" — только для WB, справочная колонка (не входит в прибыль
  // ниже, специально приглушённым цветом, чтобы не путать с реальными расходами).
  const returnCell = marketplace === 'WB'
    ? `<td class="num" style="color:var(--text-faint)" title="Справочно: возможная стоимость возврата (на ПВЗ), НЕ вычитается из прибыли — возврат случается не по каждой продаже">${fc?.estReturnCost != null ? fmtMoney(fc.estReturnCost) : '—'}</td>`
    : '';
  // Логистика WB считается по литрам объёма — даём возможность уточнить
  // объём товара прямо тут (по умолчанию 1 литр, если не указано).
  const logisticsCellContent = marketplace === 'WB'
    ? `${fc?.estLogistics != null ? fmtMoney(fc.estLogistics) : '—'}<br><input type="number" step="0.1" min="0.1" placeholder="1 л" value="${p.wbVolumeLiters ?? ''}" data-volume-field="wbVolumeLiters" style="width:55px;font-size:10px;margin-top:2px" title="Объём в литрах (по умолчанию 1 л)" />`
    : (fc?.estLogistics != null ? fmtMoney(fc.estLogistics) + badge : '—');
  return `
    <td class="num" style="border-left:2px solid var(--border)">
      <input class="cost-input" type="number" step="1" placeholder="Цена" value="${priceValue}" data-price-field="${priceFieldName(marketplace)}" style="width:85px" />
    </td>
    <td class="num">${fc?.estCommission != null ? `${fmtMoney(fc.estCommission)}${fc.estCommissionRate != null ? ` <span style="color:var(--text-faint);font-size:10px">(${fc.estCommissionRate}%)</span>` : ''}` + badge : '—'}</td>
    <td class="num">${logisticsCellContent}</td>
    ${returnCell}
    <td class="num">${fc?.estTax != null ? fmtMoney(fc.estTax) : '—'}</td>
    <td class="num ${fc?.estPayout != null ? (fc.estPayout >= 0 ? 'pos' : 'neg') : ''}" title="С учётом налога ИП">${fc?.estPayout != null ? fmtMoney(fc.estPayout) : '—'}</td>
    <td class="num ${fc?.estMarginAfterTaxPct != null ? (fc.estMarginAfterTaxPct >= 0 ? 'pos' : 'neg') : ''}" title="С учётом налога ИП">${fc?.estMarginAfterTaxPct != null ? fmtPct(fc.estMarginAfterTaxPct) : '—'}</td>
  `;
}

/** Выпадающий список категории Kaspi прямо в строке таблицы. Если точной
 *  верхней категории нет, но Kaspi прислал leaf-категорию (например,
 *  "Зонты") — показываем её как есть, это уже реальные данные, а не
 *  "нет категории". Предупреждение — только когда неизвестно вообще всё. */
/**
 * Поле выбора категории Kaspi прямо в строке таблицы — теперь поле поиска
 * (не <select>) с общим <datalist> на всю страницу: начинаешь печатать —
 * браузер сам фильтрует список по подстроке. Список включает ВСЕ категории,
 * по которым у нас есть точная ставка — и верхнего уровня, и leaf-исключения
 * (см. getAllKaspiCategoriesWithRates на сервере), а не только 15-20 верхних
 * разделов, как было раньше.
 */
/**
 * Кнопка выбора категории Kaspi прямо в строке таблицы — открывает
 * всплывающую панель (см. openCategoryPicker) с ОТДЕЛЬНЫМ полем поиска
 * сверху и прокручиваемым списком ВСЕХ категорий снизу. Никакого
 * встроенного в браузер datalist — он даёт нечёткие/непредсказуемые
 * совпадения и мешает менять уже выбранное значение.
 */
function categorySelectHtml(topCategory, leafCategory, productId, productName) {
  let label, borderColor;
  if (topCategory) {
    label = topCategory;
    borderColor = '';
  } else if (leafCategory) {
    // Реальная категория от Kaspi есть, просто не сопоставлена вручную —
    // комиссия всё равно уже считается (по leaf-исключению или безопасному
    // дефолту, см. ≈ у цифр). Кнопка открывает тот же поиск — можно уточнить.
    label = leafCategory;
    borderColor = 'border-color:var(--text-faint)';
  } else {
    label = '⚠ нет категории';
    borderColor = 'border-color:var(--warn)';
  }
  return `<button
      type="button"
      class="cost-input kaspi-category-btn"
      data-product-id="${productId}"
      data-product-name="${(productName || '').replace(/"/g, '&quot;')}"
      style="font-size:11px;margin-top:4px;text-align:left;cursor:pointer;width:100%;${borderColor}"
      title="${leafCategory ? `Категория от Kaspi: ${leafCategory}. ` : ''}Нажми, чтобы выбрать категорию из полного списка (поиск + прокрутка)">${label}</button>`;
}

let categoryPickerState = { productId: null, popupEl: null };

function closeCategoryPicker() {
  if (categoryPickerState.popupEl) {
    categoryPickerState.popupEl.remove();
    document.removeEventListener('mousedown', handleCategoryPickerOutsideClick, true);
    document.removeEventListener('keydown', handleCategoryPickerEscape);
  }
  categoryPickerState = { productId: null, popupEl: null };
}

function handleCategoryPickerOutsideClick(e) {
  if (categoryPickerState.popupEl && !categoryPickerState.popupEl.contains(e.target)) {
    closeCategoryPicker();
  }
}
function handleCategoryPickerEscape(e) {
  if (e.key === 'Escape') closeCategoryPicker();
}

/**
 * Открывает панель выбора категории. onSelect(categoryName, option) —
 * вызывается при клике по категории в списке; сама панель ничего не
 * сохраняет — это делает вызывающий код (либо PUT одного товара, либо
 * массовое проставление выбранным).
 */
/**
 * Подбирает слово из названия товара для подсказки в поиске — берёт самое
 * длинное значимое слово (длиннее стоп-слов вроде "для"/"с"/"и"), которое
 * реально даёт хотя бы одно совпадение в справочнике. Если ни одно слово
 * не дало совпадений — возвращает пустую строку (открываем с полным
 * списком, ничего не подставляем силой).
 */
function suggestCategorySearchQuery(productName) {
  if (!productName || !kaspiCategoryOptionsCache) return '';
  const stopWords = new Set(['для', 'с', 'и', 'от', 'в', 'на', 'без', 'по', 'из', 'не', 'мл', 'шт', 'гр', 'кг']);
  const words = productName
    .toLowerCase()
    .replace(/[^а-яёa-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .reverse(); // с конца фразы: в русском последнее слово обычно самое
  // конкретное существительное ("очиститель ДЛЯ ЯЗЫКА" — суть в "языка",
  // а не в общем слове "очиститель", которое совпадёт с чем угодно).

  for (const word of words) {
    const hasMatch = kaspiCategoryOptionsCache.some((c) => c.name.toLowerCase().includes(word));
    if (hasMatch) return word;
  }
  return '';
}

function openCategoryPicker(anchorEl, onSelect, productName) {
  closeCategoryPicker();

  const popup = document.createElement('div');
  popup.style.cssText = `
    position: absolute; z-index: 1000; background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); width: 340px; max-height: 380px;
    display: flex; flex-direction: column; padding: 8px;
  `;
  popup.innerHTML = `
    <input type="text" placeholder="Поиск категории…" class="category-picker-search"
      style="margin-bottom:8px;padding:7px 9px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text)" />
    <div class="category-picker-list" style="overflow-y:auto;flex:1"></div>
  `;
  document.body.appendChild(popup);

  const rect = anchorEl.getBoundingClientRect();
  const top = window.scrollY + rect.bottom + 4;
  let left = window.scrollX + rect.left;
  // Не даём панели вылезти за правый край экрана.
  if (left + 340 > window.scrollX + window.innerWidth) left = window.scrollX + window.innerWidth - 350;
  popup.style.top = `${top}px`;
  popup.style.left = `${Math.max(8, left)}px`;

  const searchInput = popup.querySelector('.category-picker-search');
  const listEl = popup.querySelector('.category-picker-list');

  function renderList(query) {
    const q = query.trim().toLowerCase();
    // Строго подстрока в названии — никакой "похожести"/нечёткого поиска
    // (п.6 запроса: не подставлять по похожим словам вроде аккумулятор/авто).
    const all = kaspiCategoryOptionsCache || [];
    const items = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
    listEl.innerHTML = items.length
      ? items.map((c) => `
          <div class="category-picker-item" data-name="${c.name.replace(/"/g, '&quot;')}"
            style="padding:7px 9px;cursor:pointer;border-radius:5px;font-size:12.5px;display:flex;justify-content:space-between;gap:8px">
            <span>${c.name}${c.level === 'leaf' ? ` <span style="color:var(--text-faint);font-size:10px">(${c.topCategory || 'точная'})</span>` : ''}</span>
            <span style="color:var(--text-faint);white-space:nowrap">${c.ratePct}%</span>
          </div>
        `).join('')
      : `<div style="padding:10px;color:var(--text-faint);font-size:12.5px">Ничего не найдено</div>`;

    listEl.querySelectorAll('.category-picker-item').forEach((item) => {
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--bg)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.addEventListener('click', () => {
        const name = item.dataset.name;
        closeCategoryPicker();
        onSelect(name, findKaspiCategoryOption(name));
      });
    });
  }

  // Подсказка по названию товара — ТОЛЬКО подставляет запрос в поиск,
  // список фильтруется как обычно, и ничего не выбирается автоматически:
  // нужен явный клик пользователя, чтобы категория сохранилась.
  const suggested = suggestCategorySearchQuery(productName);
  searchInput.value = suggested;
  renderList(suggested);
  searchInput.addEventListener('input', () => renderList(searchInput.value));
  searchInput.focus();
  if (suggested) searchInput.select(); // выделяем подсказку, чтобы легко было стереть и напечатать своё

  categoryPickerState = { popupEl: popup };
  // Небольшая задержка перед подпиской на "клик вне панели" — иначе тот же
  // клик, которым открыли панель, сразу же её закрыл бы.
  setTimeout(() => {
    document.addEventListener('mousedown', handleCategoryPickerOutsideClick, true);
    document.addEventListener('keydown', handleCategoryPickerEscape);
  }, 0);
}

async function saveCategorySelection(productId, categoryName) {
  const option = findKaspiCategoryOption(categoryName);
  const payload = option?.level === 'leaf' ? { kaspiLeafCategory: categoryName } : { kaspiTopCategory: categoryName };
  try {
    await api(`/products/${productId}`, { method: 'PUT', body: JSON.stringify(payload) });
    await loadProductsAdminTable();
  } catch (err) {
    alert('Не удалось сохранить категорию: ' + err.message);
  }
}

/** Какие площадки показывать в таблице — строго по фильтру вверху страницы.
 *  Одна выбрана — одна широкая таблица. "Всё вместе" — все три (компромисс,
 *  раз явного выбора нет). */
function getVisibleMarketplaces() {
  if (state.marketplace === 'KASPI') return ['KASPI'];
  if (state.marketplace === 'OZON') return ['OZON'];
  if (state.marketplace === 'WB') return ['WB'];
  return ['KASPI', 'OZON', 'WB'];
}

function renderProductsTableHead(marketplaces) {
  const thead = document.getElementById('productsAdminThead');
  const selectAllCb = `<th rowspan="${marketplaces.length === 1 ? 1 : 2}"><input type="checkbox" id="productsSelectAllOnPage" title="Выбрать все на этой странице" /></th>`;
  // Подпись колонок "Комиссия"/"Логистика" явно поясняет, что это значит на
  // выбранной площадке (Kaspi/Ozon/WB считают и называют это по-разному).
  const commissionTitle = (mp) => mp === 'OZON' ? 'Вознаграждение Ozon (комиссия площадки)' : mp === 'KASPI' ? 'Комиссия Kaspi по официальному тарифу категории' : 'Комиссия площадки';
  const logisticsTitle = (mp) => mp === 'OZON' ? 'Логистика Ozon: магистральная логистика + последняя миля' : mp === 'KASPI' ? 'Логистика Kaspi Доставки по официальному тарифу' : 'Логистика площадки';
  if (marketplaces.length === 1) {
    // Одна площадка — шапка в один ряд, широкие понятные колонки, без group-заголовков.
    const mp = marketplaces[0];
    const returnHeader = mp === 'WB' ? `<th class="num" title="Справочно: НЕ входит в расчёт прибыли">Возврат</th>` : '';
    thead.innerHTML = `
      <tr>
        ${selectAllCb}
        <th>SKU</th><th>Название</th><th>Артикул ${mpLabel(mp)}</th>
        <th class="num">Себестоимость</th>
        <th class="num">Цена</th>
        <th class="num" title="${commissionTitle(mp)}">Комиссия</th>
        <th class="num" title="${logisticsTitle(mp)}">Логистика</th>
        ${returnHeader}
        <th class="num">Налог</th>
        <th class="num" title="С учётом налога ИП">Прибыль/шт</th>
        <th class="num" title="С учётом налога ИП">Маржа</th>
        <th>Активен</th><th></th>
      </tr>
    `;
  } else {
    // "Всё вместе" — три компактных блока, как раньше (без единственно
    // очевидного выбора площадки это разумный компромисс). У WB на одну
    // колонку больше ("Возврат") — это нормально, колонки не обязаны
    // совпадать между блоками разных площадок.
    const groupHeaders = marketplaces.map((mp) => `<th colspan="${mp === 'WB' ? 7 : 6}" style="text-align:center;border-left:2px solid var(--border)"><span class="dot dot--${mp.toLowerCase()}"></span> ${mpLabel(mp)}</th>`).join('');
    const subHeaders = marketplaces.map((mp) => `
      <th class="num" style="border-left:2px solid var(--border)">Цена</th>
      <th class="num" title="${commissionTitle(mp)}">Комиссия</th><th class="num" title="${logisticsTitle(mp)}">Логистика</th>
      ${mp === 'WB' ? `<th class="num" title="Справочно: НЕ входит в расчёт прибыли">Возврат</th>` : ''}
      <th class="num">Налог</th>
      <th class="num" title="С учётом налога ИП">Прибыль/шт</th><th class="num" title="С учётом налога ИП">Маржа</th>
    `).join('');
    thead.innerHTML = `
      <tr>
        ${selectAllCb}
        <th rowspan="2">SKU</th><th rowspan="2">Название</th><th rowspan="2">Артикулы</th>
        <th rowspan="2" class="num">Себестоимость</th>
        ${groupHeaders}
        <th rowspan="2">Активен</th><th rowspan="2"></th>
      </tr>
      <tr>${subHeaders}</tr>
    `;
  }
}

function renderProductsAdminTable() {
  const filter = document.querySelector('#productStatusTabs button.is-active')?.dataset.filter || 'active';
  let products = allProductsCache;
  if (filter === 'active') products = products.filter((p) => p.active !== false);
  if (filter === 'inactive') products = products.filter((p) => p.active === false);

  // Фильтр по площадке (кнопки Kaspi/Ozon/WB вверху страницы) — товар
  // считается "принадлежащим" площадке, если у него заполнен
  // соответствующий артикул (kaspiSku / ozonOfferId / wbArticle). Тот же
  // фильтр определяет, какую таблицу (широкую по одной площадке или все
  // три компактно) сейчас показывать.
  if (state.marketplace === 'KASPI') products = products.filter((p) => p.kaspiSku);
  if (state.marketplace === 'OZON') products = products.filter((p) => p.ozonOfferId);
  if (state.marketplace === 'WB') products = products.filter((p) => p.wbArticle);

  const marketplaces = getVisibleMarketplaces();
  renderProductsTableHead(marketplaces);

  // Сортировка "убыточные — наверх": при одной выбранной площадке сортируем
  // по прогнозной прибыли ПОСЛЕ НАЛОГА (estPayout) по возрастанию — именно
  // это теперь основная колонка "Прибыль/шт" в таблице, самые большие
  // убытки видны сразу, без прокрутки вниз. Товары без прогноза (нет
  // данных) — в самый конец, они не "плохие", просто про них пока нечего сказать.
  if (marketplaces.length === 1) {
    const mp = marketplaces[0];
    products = [...products].sort((a, b) => {
      const pa = productsForecastCache.get(`${a.id}:${mp}`)?.estPayout;
      const pb = productsForecastCache.get(`${b.id}:${mp}`)?.estPayout;
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pa - pb;
    });
  }

  const tbody = document.querySelector('#productsAdminTable tbody');
  const totalCols = 5 + marketplaces.reduce((sum, mp) => sum + (mp === 'WB' ? 7 : 6), 0) + 2; // +1 за колонку чекбокса, 6 колонок на площадку (7 у WB — добавлена "Возврат")

  // Пагинация — по PRODUCTS_PAGE_SIZE карточек на страницу, чтобы даже при
  // тысяче с лишним товаров список оставался удобным.
  const totalPages = Math.max(1, Math.ceil(products.length / PRODUCTS_PAGE_SIZE));
  if (productsCurrentPage > totalPages) productsCurrentPage = totalPages;
  if (productsCurrentPage < 1) productsCurrentPage = 1;
  const pageStart = (productsCurrentPage - 1) * PRODUCTS_PAGE_SIZE;
  const pageProducts = products.slice(pageStart, pageStart + PRODUCTS_PAGE_SIZE);

  renderProductsPagination(totalPages, products.length);
  updateProductsSelectedCount();

  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="${totalCols}" style="color:var(--text-faint)">Товаров в этой категории нет</td></tr>`;
    return;
  }
  tbody.innerHTML = pageProducts.map((p) => {
    // Одна площадка выбрана — в колонке "Артикул" показываем только его,
    // а для Kaspi ещё и редактируемый выбор категории (без неё точный
    // тариф комиссии не посчитать). "Всё вместе" — показываем все
    // привязанные артикулы разом, категорию там же текстом (не мешаем
    // редактированию в узкой многоплощадочной шапке).
    let articlesCell;
    if (marketplaces.length === 1) {
      const mp = marketplaces[0];
      const value = mp === 'KASPI' ? p.kaspiSku : mp === 'OZON' ? p.ozonOfferId : p.wbArticle;
      articlesCell = `${value ?? '—'}${mp === 'KASPI' ? categorySelectHtml(p.kaspiTopCategory, p.kaspiLeafCategory, p.id, p.name) : ''}`;
    } else {
      const kaspiHint = p.kaspiSku
        ? (p.kaspiTopCategory || p.kaspiLeafCategory
            ? `<br><span style="color:var(--text-faint);font-size:11px">${p.kaspiLeafCategory ?? p.kaspiTopCategory}</span>`
            : `<br><span style="color:var(--warn);font-size:11px" title="Категория неизвестна — комиссия считается по усреднённой ставке 12.5%">⚠ нет категории</span>`)
        : '';
      articlesCell = [
        p.kaspiSku ? `<span title="Kaspi"><i class="dot dot--kaspi"></i> ${p.kaspiSku}</span>` : '',
        p.ozonOfferId ? `<span title="Ozon"><i class="dot dot--ozon"></i> ${p.ozonOfferId}</span>` : '',
        p.wbArticle ? `<span title="WB"><i class="dot dot--wb"></i> ${p.wbArticle}</span>` : '',
      ].filter(Boolean).join('<br>') || '—';
      articlesCell += kaspiHint;
    }

    const forecastCells = marketplaces.map((mp) => renderForecastCells(p, mp)).join('');

    return `
    <tr data-id="${p.id}">
      <td><input type="checkbox" class="products-row-select" data-id="${p.id}" ${selectedProductIds.has(p.id) ? 'checked' : ''} /></td>
      <td class="name-cell">${p.sku}</td>
      <td class="name-cell">${p.name}</td>
      <td class="name-cell" style="font-size:11px">${articlesCell}</td>
      <td class="num"><input class="cost-input" type="number" step="0.01" value="${p.costPrice}" data-field="costPrice" /></td>
      ${forecastCells}
      <td><input type="checkbox" data-field="active" ${p.active !== false ? 'checked' : ''} /></td>
      <td><button class="link-btn" data-action="delete">✕</button></td>
    </tr>
  `;
  }).join('');

  // Чекбокс "выбрать всё на странице" — отражает состояние ТОЛЬКО видимых
  // сейчас строк (не всей выборки целиком).
  const selectAllCb = document.getElementById('productsSelectAllOnPage');
  if (selectAllCb) {
    selectAllCb.checked = pageProducts.length > 0 && pageProducts.every((p) => selectedProductIds.has(p.id));
    selectAllCb.onchange = () => {
      pageProducts.forEach((p) => {
        if (selectAllCb.checked) selectedProductIds.add(p.id);
        else selectedProductIds.delete(p.id);
      });
      renderProductsAdminTable();
    };
  }

  tbody.querySelectorAll('input.products-row-select').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) selectedProductIds.add(id);
      else selectedProductIds.delete(id);
      updateProductsSelectedCount();
      const selectAll = document.getElementById('productsSelectAllOnPage');
      if (selectAll) selectAll.checked = pageProducts.every((p) => selectedProductIds.has(p.id));
    });
  });

  tbody.querySelectorAll('input[data-field="costPrice"]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      try {
        await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ costPrice: Number(e.target.value) }) });
        await loadProductsAdminTable();
      } catch (err) {
        alert('Не удалось сохранить себестоимость: ' + err.message);
      }
    });
  });
  // Цена по площадке (для прогноза) — редактируется прямо в таблице.
  tbody.querySelectorAll('input[data-price-field]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      const field = e.target.dataset.priceField;
      const value = e.target.value === '' ? null : Number(e.target.value);
      try {
        await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) });
        await loadProductsAdminTable();
      } catch (err) {
        alert('Не удалось сохранить цену: ' + err.message);
      }
    });
  });
  // Объём товара (WB, для расчёта логистики по литрам) — редактируется прямо в таблице.
  tbody.querySelectorAll('input[data-volume-field]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      const field = e.target.dataset.volumeField;
      const value = e.target.value === '' ? null : Number(e.target.value);
      try {
        await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) });
        await loadProductsAdminTable();
      } catch (err) {
        alert('Не удалось сохранить объём: ' + err.message);
      }
    });
  });
  // Категория Kaspi — кнопка открывает панель поиска (см. openCategoryPicker).
  tbody.querySelectorAll('button.kaspi-category-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const productId = btn.dataset.productId;
      openCategoryPicker(btn, (categoryName) => saveCategorySelection(productId, categoryName), btn.dataset.productName);
    });
  });
  tbody.querySelectorAll('input[data-field="active"]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      try {
        await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ active: e.target.checked }) });
        await loadProductsAdminTable();
      } catch (err) {
        alert('Не удалось изменить статус: ' + err.message);
        e.target.checked = !e.target.checked;
      }
    });
  });
  tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      if (!confirm('Удалить товар?')) return;
      try {
        await api(`/products/${id}`, { method: 'DELETE' });
        await loadProductsAdminTable();
      } catch (err) {
        alert('Не удалось удалить товар: ' + err.message);
      }
    });
  });
}

function updateProductsSelectedCount() {
  const el = document.getElementById('productsSelectedCount');
  if (el) el.textContent = `Выбрано: ${selectedProductIds.size}`;

  // Счётчик "в продаже" — считается ПО ТЕКУЩЕЙ выбранной площадке (кнопки
  // Kaspi/Ozon/WB вверху), не всегда по Kaspi. При "Всё вместе" показываем
  // по Kaspi как наиболее часто интересующей площадке (там же и главные
  // проблемы с ручным статусом). Это НЕ живой статус с самой площадки (у
  // Kaspi/WB нет такого API-метода) — при изменении переключателя
  // "Активен" число сразу обновится, но реальную рассинхронизацию с
  // кабинетом может показать только сам продавец, переключив статус вручную.
  const countEl = document.getElementById('productsInSaleCount');
  if (countEl) {
    const mp = state.marketplace || 'KASPI';
    const articleField = mp === 'KASPI' ? 'kaspiSku' : mp === 'OZON' ? 'ozonOfferId' : 'wbArticle';
    const mpProducts = allProductsCache.filter((p) => p[articleField]);
    const inSale = mpProducts.filter((p) => p.active !== false).length;
    countEl.textContent = `${inSale} в продаже (${mpLabel(mp)})`;
  }
}

function renderProductsPagination(totalPages, totalCount) {
  const el = document.getElementById('productsPagination');
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const btn = (label, page, disabled, active) =>
    `<button class="btn btn--ghost" data-page="${page}" ${disabled ? 'disabled' : ''} style="padding:6px 12px;min-width:36px;${active ? 'background:var(--primary);color:#fff' : ''}">${label}</button>`;

  let pages = [];
  // Не более 7 кнопок с номерами страниц — с многоточиями по краям для очень длинных списков.
  if (totalPages <= 7) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else if (productsCurrentPage <= 4) {
    pages = [1, 2, 3, 4, 5, '…', totalPages];
  } else if (productsCurrentPage >= totalPages - 3) {
    pages = [1, '…', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  } else {
    pages = [1, '…', productsCurrentPage - 1, productsCurrentPage, productsCurrentPage + 1, '…', totalPages];
  }

  el.innerHTML = `
    <span style="font-size:12px;color:var(--text-faint);margin-right:8px">Всего: ${fmt.format(totalCount)}</span>
    ${btn('← Назад', productsCurrentPage - 1, productsCurrentPage === 1, false)}
    ${pages.map((p) => (p === '…' ? `<span style="padding:0 4px;color:var(--text-faint)">…</span>` : btn(String(p), p, false, p === productsCurrentPage))).join('')}
    ${btn('Далее →', productsCurrentPage + 1, productsCurrentPage === totalPages, false)}
  `;

  el.querySelectorAll('button[data-page]').forEach((b) => {
    b.addEventListener('click', () => {
      productsCurrentPage = Number(b.dataset.page);
      renderProductsAdminTable();
      document.getElementById('productsAdminTable')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// =====================================================================
// ФИНАНСЫ
// =====================================================================
let expenseFormWired = false;

function wireExpenseFormOnce() {
  if (expenseFormWired) return;
  expenseFormWired = true;
  const dateInput = document.querySelector('#expenseForm input[name="date"]');
  if (dateInput) dateInput.value = todayISO();

  document.getElementById('expenseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      marketplace: fd.get('marketplace'),
      date: fd.get('date'),
      amount: Number(fd.get('amount')),
      note: fd.get('note') || undefined,
    };
    await api('/expenses/ad-spend', { method: 'POST', body: JSON.stringify(payload) });
    e.target.reset();
    dateInput.value = todayISO();
    await loadFinancePage();
  });
}

async function loadFinancePage() {
  wireExpenseFormOnce();
  const summary = await fetchSummary();
  renderWaterfall(summary);
  await Promise.all([loadByProductFinance(), loadExpenses()]);
}

async function loadByProductFinance() {
  const data = await api(`/analytics/by-product?${qs({ from: state.from, to: state.to, marketplace: state.marketplace })}`);
  const tbody = document.querySelector('#productsTable tbody');
  const tfoot = document.querySelector('#productsTable tfoot');
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="13" style="color:var(--text-faint)">Нет данных за период</td></tr>`;
    tfoot.innerHTML = '';
    return;
  }
  tbody.innerHTML = data.map((p) => `
    <tr>
      <td class="name-cell">${p.name}</td>
      <td class="num">${fmt.format(p.quantity)}</td>
      <td class="num">${fmtMoney(p.avgPrice)}</td>
      <td class="num">${fmtMoney(p.revenue)}</td>
      <td class="num">${fmtMoney(p.cogs)}</td>
      <td class="num">${fmtMoney(p.commission)}${p.commissionRate ? ` <span style="color:var(--text-faint);font-size:10px">(${p.commissionRate}%)</span>` : ''}</td>
      <td class="num">${fmtMoney(p.logistics)}</td>
      <td class="num">${fmtMoney(p.adSpend)}</td>
      <td class="num ${p.netProfit >= 0 ? 'pos' : 'neg'}">${fmtMoney(p.netProfit)}</td>
      <td class="num ${p.marginPct >= 0 ? 'pos' : 'neg'}">${fmtPct(p.marginPct)}</td>
      <td class="num">${fmtMoney(p.tax)}${p.taxRatePct ? ` <span style="color:var(--text-faint);font-size:10px">(${p.taxRatePct}%)</span>` : ''}</td>
      <td class="num ${p.payout >= 0 ? 'pos' : 'neg'}">${fmtMoney(p.payout)}</td>
      <td class="num ${p.marginAfterTaxPct >= 0 ? 'pos' : 'neg'}">${fmtPct(p.marginAfterTaxPct)}</td>
    </tr>
  `).join('');

  // Строка "Итого" — суммы по всем денежным колонкам. Средняя цена и маржа
  // считаются заново от суммарных чисел (не среднее из строк — так корректнее).
  // Сумма "tax" по всем товарам здесь СХОДИТСЯ с summary.taxAmount на карточках
  // выше — обе считаются от одной и той же выручки с одной и той же ставкой.
  const totals = data.reduce((acc, p) => ({
    quantity: acc.quantity + p.quantity,
    revenue: acc.revenue + p.revenue,
    cogs: acc.cogs + p.cogs,
    commission: acc.commission + p.commission,
    logistics: acc.logistics + p.logistics,
    adSpend: acc.adSpend + p.adSpend,
    netProfit: acc.netProfit + p.netProfit,
    tax: acc.tax + p.tax,
    payout: acc.payout + p.payout,
  }), { quantity: 0, revenue: 0, cogs: 0, commission: 0, logistics: 0, adSpend: 0, netProfit: 0, tax: 0, payout: 0 });
  const totalMarginPct = totals.revenue > 0 ? (totals.netProfit / totals.revenue) * 100 : 0;
  const totalMarginAfterTaxPct = totals.revenue > 0 ? (totals.payout / totals.revenue) * 100 : 0;
  const totalAvgPrice = totals.quantity > 0 ? totals.revenue / totals.quantity : 0;

  tfoot.innerHTML = `
    <tr>
      <td>Итого</td>
      <td class="num">${fmt.format(totals.quantity)}</td>
      <td class="num">${fmtMoney(totalAvgPrice)}</td>
      <td class="num">${fmtMoney(totals.revenue)}</td>
      <td class="num">${fmtMoney(totals.cogs)}</td>
      <td class="num">${fmtMoney(totals.commission)}</td>
      <td class="num">${fmtMoney(totals.logistics)}</td>
      <td class="num">${fmtMoney(totals.adSpend)}</td>
      <td class="num ${totals.netProfit >= 0 ? 'pos' : 'neg'}">${fmtMoney(totals.netProfit)}</td>
      <td class="num ${totalMarginPct >= 0 ? 'pos' : 'neg'}">${fmtPct(totalMarginPct)}</td>
      <td class="num">${fmtMoney(totals.tax)}</td>
      <td class="num ${totals.payout >= 0 ? 'pos' : 'neg'}">${fmtMoney(totals.payout)}</td>
      <td class="num ${totalMarginAfterTaxPct >= 0 ? 'pos' : 'neg'}">${fmtPct(totalMarginAfterTaxPct)}</td>
    </tr>
  `;
}

async function loadExpenses() {
  const items = await api(`/expenses/ad-spend?${qs({ from: state.from, to: state.to })}`);
  const tbody = document.querySelector('#expensesTable tbody');
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-faint)">Расходы не добавлены</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map((i) => `
    <tr data-id="${i.id}">
      <td>${new Date(i.date).toLocaleDateString('ru-RU')}</td>
      <td><span class="mp-tag"><i class="dot dot--${i.marketplace.toLowerCase()}"></i>${mpLabel(i.marketplace)}</span></td>
      <td class="num">${fmtMoney(i.amount)}</td>
      <td class="name-cell">${i.note ?? ''}</td>
      <td><button class="link-btn" data-action="delete">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      await api(`/expenses/ad-spend/${id}`, { method: 'DELETE' });
      await loadFinancePage();
    });
  });
}

// =====================================================================
// ОТЗЫВЫ
// =====================================================================
let reviewsBtnWired = false;

function wireReviewsButtonOnce() {
  if (reviewsBtnWired) return;
  reviewsBtnWired = true;
  document.getElementById('refreshReviewsBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshReviewsBtn');
    btn.textContent = '…'; btn.disabled = true;
    try {
      await api('/reviews/refresh-all', { method: 'POST' });
      await loadReviewsPage();
    } finally {
      btn.textContent = '↻ Обновить всё'; btn.disabled = false;
    }
  });
}

async function loadReviewsPage() {
  wireReviewsButtonOnce();
  const reviews = await api('/reviews');
  const tbody = document.querySelector('#reviewsTable tbody');
  if (!reviews.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-faint)">Добавь ссылку на Kaspi в разделе «Демпинг», чтобы видеть отзывы</td></tr>`;
    return;
  }
  tbody.innerHTML = reviews.map((r) => `
    <tr data-id="${r.id}">
      <td class="name-cell">${r.name}</td>
      <td class="num">${r.kaspiRating ?? '—'}</td>
      <td class="num">${r.kaspiReviewCount ?? '—'}</td>
      <td>${r.reviewsUpdatedAt ? new Date(r.reviewsUpdatedAt).toLocaleString('ru-RU') : '—'}</td>
      <td><button class="link-btn" data-action="refresh">↻</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('button[data-action="refresh"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      btn.textContent = '…';
      await api(`/reviews/${id}/refresh`, { method: 'POST' });
      await loadReviewsPage();
    });
  });
}

// =====================================================================
// КАЛЬКУЛЯТОР МАРЖИ
// =====================================================================
let marginFormWired = false;
let lastMarginPayload = null; // последний запрос — переиспользуется слайдером "что если"

function buildMarginPayload(fd, priceOverride) {
  return {
    price: priceOverride ?? Number(fd.get('price')),
    price1688: Number(fd.get('price1688')) || 0,
    cargoRatePerKg: Number(fd.get('cargoRatePerKg')) || 0,
    packagingCost: Number(fd.get('packagingCost')) || 0,
    weightKg: Number(fd.get('weightKg')) || 0.5,
    kaspiTopCategory: fd.get('kaspiTopCategory'),
    deliveryZone: fd.get('deliveryZone'),
    targetMarginPct: Number(fd.get('targetMarginPct')) || 20,
  };
}

function renderMarginResult(result) {
  const verdictIsBuy = result.verdict === 'BUY';
  const verdictColor = verdictIsBuy ? 'var(--accent)' : 'var(--loss)';
  const verdictBg = verdictIsBuy ? 'var(--accent-soft)' : 'var(--loss-soft)';

  document.getElementById('marginCalcResult').innerHTML = `
    <div style="display:flex;gap:20px;margin-top:16px;flex-wrap:wrap">
      <div style="flex:1 1 220px;background:${verdictBg};border-radius:10px;padding:18px;">
        <div style="font-family:var(--font-display);font-size:20px;font-weight:700;color:${verdictColor}">
          ${verdictIsBuy ? '✓ Брать' : '✕ Не брать'}
        </div>
        <div style="font-size:13px;color:var(--text-muted);margin-top:4px">прибыль ${fmtMoney(result.netProfit)} с единицы</div>
        <div style="margin-top:14px;font-size:12.5px;color:var(--text-muted)">
          Категория: <strong style="color:var(--text)">${result.kaspiTopCategory ?? '—'}</strong>${result.commissionRate != null ? ` · комиссия ${result.commissionRate}%` : ''}
        </div>
        <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px">
          Цель ${result.targetMarginPct}% —
          <strong style="color:${result.goalReached ? 'var(--accent)' : 'var(--loss)'}">${result.goalReached ? 'достигнута ✓' : `не достигнута (сейчас ${result.marginPct}%)`}</strong>
        </div>
      </div>

      <div style="flex:1 1 260px;background:var(--bg);border-radius:10px;padding:18px;font-family:var(--font-mono);font-size:13px">
        <div style="display:flex;justify-content:space-between;padding:4px 0"><span>Цена Kaspi</span><span>${fmtMoney(result.price)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;color:var(--loss)"><span>− Комиссия Kaspi${result.commissionRate != null ? ` (${result.commissionRate}%)` : ''}</span><span>−${fmtMoney(result.commission)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;color:var(--loss)"><span>− Логистика Kaspi</span><span>−${fmtMoney(result.logistics)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;color:var(--loss)" title="1688: ${fmtMoney(result.price1688)} · карго: ${fmtMoney(result.cargoCost)} · упаковка: ${fmtMoney(result.packagingCost)}">
          <span>− Себестоимость</span><span>−${fmtMoney(result.costPrice)}</span>
        </div>
        <div style="font-size:11px;color:var(--text-faint);padding:0 0 8px">
          1688: ${fmtMoney(result.price1688)} · карго: ${fmtMoney(result.cargoCost)} · упаковка: ${fmtMoney(result.packagingCost)}
        </div>
        <div style="display:flex;justify-content:space-between;padding:8px 0 0;border-top:1px solid var(--border);font-weight:600;color:${verdictColor}">
          <span>= Прибыль</span><span>${fmtMoney(result.netProfit)} (${result.marginPct}%)</span>
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top:16px;background:var(--bg)">
      <div class="panel__head"><h2>Что если уронить цену под демпинг</h2></div>
      <input type="range" id="marginWhatIfSlider" min="${Math.round(result.price * 0.5)}" max="${result.price}" value="${result.price}" style="width:100%" />
      <div id="marginWhatIfResult" style="display:flex;justify-content:space-between;margin-top:8px;font-family:var(--font-mono);font-size:13px">
        <span>при ${fmtMoney(result.price)}</span>
        <span>маржа <strong class="${result.marginPct >= 0 ? 'pos' : 'neg'}">${result.marginPct}%</strong></span>
      </div>
    </div>
  `;

  const slider = document.getElementById('marginWhatIfSlider');
  let debounceTimer;
  slider.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const price = Number(slider.value);
    debounceTimer = setTimeout(async () => {
      if (!lastMarginPayload) return;
      const whatIfResult = await api('/margin-calculator/calculate', {
        method: 'POST',
        body: JSON.stringify({ ...lastMarginPayload, price }),
      });
      document.getElementById('marginWhatIfResult').innerHTML = `
        <span>при ${fmtMoney(price)}</span>
        <span>маржа <strong class="${whatIfResult.marginPct >= 0 ? 'pos' : 'neg'}">${whatIfResult.marginPct}%</strong></span>
      `;
    }, 250);
  });
}

function wireMarginFormOnce() {
  if (marginFormWired) return;
  marginFormWired = true;

  document.getElementById('marginModeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#marginModeSeg button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById('marginScrapeForm').style.display = btn.dataset.mode === 'link' ? 'flex' : 'none';
  });

  document.getElementById('marginScrapeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = new FormData(e.target).get('url');
    const btn = e.target.querySelector('button');
    btn.textContent = '…'; btn.disabled = true;
    try {
      const info = await api('/margin-calculator/scrape', { method: 'POST', body: JSON.stringify({ url }) });
      if (info.price) document.querySelector('#marginCalcForm input[name="price"]').value = info.price;
    } catch (err) {
      alert('Не удалось прочитать страницу: ' + err.message);
    } finally {
      btn.textContent = 'Заполнить цену'; btn.disabled = false;
    }
  });

  document.getElementById('marginCalcForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = buildMarginPayload(fd);
    lastMarginPayload = payload;
    try {
      const result = await api('/margin-calculator/calculate', { method: 'POST', body: JSON.stringify(payload) });
      renderMarginResult({ ...result, kaspiTopCategory: payload.kaspiTopCategory });
    } catch (err) {
      alert('Не удалось посчитать: ' + err.message);
    }
  });
}

async function loadMarginPage() {
  wireMarginFormOnce();
  await loadKaspiCategoriesIntoSelect(document.getElementById('marginCategorySelect'));
}

// =====================================================================
// НИШИ (только Kaspi — MVP)
// =====================================================================
let nicheFormWired = false;

function nicheVerdictLabel(verdict) {
  if (verdict === 'strong') return { text: '✓ Сильная ниша', color: 'var(--accent)' };
  if (verdict === 'medium') return { text: '~ Средняя ниша', color: 'var(--warn)' };
  if (verdict === 'weak') return { text: '✕ Слабая ниша', color: 'var(--loss)' };
  return { text: '? Недостаточно данных', color: 'var(--text-faint)' };
}

function renderNicheResult(r) {
  const v = nicheVerdictLabel(r.verdict);
  const el = document.getElementById('nicheResult');

  const ownBlock = r.isOwnProduct && r.ownProductExactData ? `
    <div class="panel" style="border-color:rgba(22,163,74,0.35);background:var(--accent-soft)">
      <div class="panel__head"><h2>✓ Этот артикул уже есть в твоём каталоге</h2></div>
      <p class="panel__hint">Ниже — точные цифры из реальной юнит-экономики (не оценка).</p>
      <div class="kpi-grid">
        ${kpiCardsHtml([
          { label: 'Твоя цена', value: r.ownProductExactData.referencePrice != null ? fmtMoney(r.ownProductExactData.referencePrice) : '—' },
          { label: 'Комиссия', value: r.ownProductExactData.estCommission != null ? fmtMoney(r.ownProductExactData.estCommission) : '—' },
          { label: 'Логистика', value: r.ownProductExactData.estLogistics != null ? fmtMoney(r.ownProductExactData.estLogistics) : '—' },
          { label: 'Налог', value: r.ownProductExactData.estTax != null ? fmtMoney(r.ownProductExactData.estTax) : '—' },
          { label: 'К выводу с 1 шт', value: r.ownProductExactData.estPayout != null ? fmtMoney(r.ownProductExactData.estPayout) : '—', cls: (r.ownProductExactData.estPayout ?? 0) >= 0 ? 'pos' : 'neg', accent: true },
          { label: 'Маржа после налога', value: r.ownProductExactData.estMarginAfterTaxPct != null ? fmtPct(r.ownProductExactData.estMarginAfterTaxPct) : '—' },
        ])}
      </div>
    </div>
  ` : '';

  el.innerHTML = `
    ${ownBlock}
    <div class="panel">
      <div class="panel__head">
        <h2>${r.productName || 'Товар не распознан'}</h2>
        <span style="font-weight:700;color:${v.color}">${v.text}</span>
      </div>
      <p class="panel__hint">${r.verdictReason}</p>
      <p class="panel__hint" style="color:var(--warn)">⚠ ${r.dataQualityWarning}</p>

      <div class="kpi-grid">
        ${kpiCardsHtml([
          { label: 'Категория', value: r.category || '—' },
          { label: 'Продавцов на карточке', value: r.sellerCount ?? '—' },
          { label: 'Диапазон цен', value: (r.priceMin != null && r.priceMax != null) ? `${fmtMoney(r.priceMin)} – ${fmtMoney(r.priceMax)}` : '—' },
          { label: 'Рейтинг / отзывов', value: r.ratingValue != null ? `${r.ratingValue} ⭐ (${r.reviewCount ?? 0})` : '—' },
        ])}
      </div>

      <div class="panel__head" style="margin-top:20px"><h2>Оценка за 30 дней (ориентировочно)</h2></div>
      <div class="kpi-grid">
        ${kpiCardsHtml([
          { label: 'Продано, шт (оценка)', value: r.estimatedMonthlySales ?? '—' },
          { label: 'Выручка (оценка)', value: r.estimatedMonthlyRevenue != null ? fmtMoney(r.estimatedMonthlyRevenue) : '—' },
          { label: `Комиссия (${r.commissionRatePct ?? '—'}%)`, value: r.estimatedMonthlyCommission != null ? fmtMoney(r.estimatedMonthlyCommission) : '—' },
          { label: 'Логистика (оценка)', value: r.estimatedMonthlyLogistics != null ? fmtMoney(r.estimatedMonthlyLogistics) : '—' },
          { label: `Налог ИП ${r.taxRatePct}%`, value: r.estimatedMonthlyTax != null ? fmtMoney(r.estimatedMonthlyTax) : '—' },
          { label: 'Чистая прибыль (оценка)', value: r.estimatedMonthlyNetProfit != null ? fmtMoney(r.estimatedMonthlyNetProfit) : '—', cls: (r.estimatedMonthlyNetProfit ?? 0) >= 0 ? 'pos' : 'neg', accent: true },
        ])}
      </div>
    </div>
  `;
}

function wireNicheFormOnce() {
  if (nicheFormWired) return;
  nicheFormWired = true;

  document.getElementById('nicheAnalyzeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = new FormData(e.target).get('input');
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    document.getElementById('nicheResult').innerHTML = `<p class="panel__hint">Читаю страницу товара на kaspi.kz…</p>`;
    try {
      const result = await api('/niches/analyze', { method: 'POST', body: JSON.stringify({ input }) });
      renderNicheResult(result);
    } catch (err) {
      document.getElementById('nicheResult').innerHTML = '';
      alert('Не удалось проанализировать: ' + err.message);
    } finally {
      btn.textContent = originalText; btn.disabled = false;
    }
  });
}

// =====================================================================
// MY MARKET (канал APP) — кабинет продавца: Главная / Товары / Цены и
// акции / Заказы / Финансы / Загрузка Excel. Везде — ТОЛЬКО данные
// ShopOrder/Product.shop* (канал APP), никогда не подмешиваются цифры
// Kaspi/Ozon/WB.
// =====================================================================
let myMarketTabWired = false;
let myMarketProductsCache = [];
let myMarketChartInstance = null;
let myMarketEditingProductId = null;

const MY_MARKET_TABS = ['home', 'products', 'prices', 'orders', 'analytics', 'couriers', 'finance', 'upload'];

function wireMyMarketTabsOnce() {
  if (myMarketTabWired) return;
  myMarketTabWired = true;

  document.getElementById('mymarketTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    switchMyMarketTab(btn.dataset.tab);
  });

  document.getElementById('mymarketOrderStatusTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#mymarketOrderStatusTabs button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    loadMyMarketOrders();
  });

  document.getElementById('mymarketProductFilterTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#mymarketProductFilterTabs button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    renderMyMarketProductsTable();
  });

  document.getElementById('mymarketProductsSearch').addEventListener('input', () => renderMyMarketProductsTable());

  document.getElementById('mymarketDownloadTemplateBtn').addEventListener('click', downloadMyMarketTemplate);
  document.getElementById('mymarketDownloadTemplateBtn2').addEventListener('click', downloadMyMarketTemplate);
  document.getElementById('mymarketGoUploadBtn').addEventListener('click', () => switchMyMarketTab('upload'));
  document.getElementById('mymarketNewProductBtn').addEventListener('click', openMyMarketNewProductCard);

  // --- Загрузка Excel: выбор файла (кнопка / перетаскивание) ---
  document.getElementById('mmChooseUploadFileBtn').addEventListener('click', () => document.getElementById('mymarketUploadFile').click());
  document.getElementById('mymarketUploadFile').addEventListener('change', (e) => {
    if (e.target.files[0]) handleMyMarketFileSelected(e.target.files[0]);
  });
  const uploadDropzone = document.getElementById('mmUploadDropzone');
  uploadDropzone.addEventListener('dragover', (e) => { e.preventDefault(); uploadDropzone.classList.add('is-dragover'); });
  uploadDropzone.addEventListener('dragleave', () => uploadDropzone.classList.remove('is-dragover'));
  uploadDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadDropzone.classList.remove('is-dragover');
    if (e.dataTransfer.files[0]) handleMyMarketFileSelected(e.dataTransfer.files[0]);
  });
  // --- Экран проверки: отмена / подтверждение записи в базу ---
  document.getElementById('mmPreviewCancelBtn').addEventListener('click', resetMmUploadScreen);
  document.getElementById('mmPreviewConfirmBtn').addEventListener('click', confirmMmUpload);

  // Карточка товара — модальное окно
  document.getElementById('mymarketProductCardClose').addEventListener('click', closeMyMarketProductCard);
  document.getElementById('mymarketProductCardCancel').addEventListener('click', closeMyMarketProductCard);
  document.getElementById('mymarketProductCardOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'mymarketProductCardOverlay') closeMyMarketProductCard();
  });
  document.getElementById('mymarketProductCardForm').addEventListener('submit', saveMyMarketProductCard);
  // Esc — тоже закрывает карточку (не было подключено, только крестик/
  // отмена/клик по фону). Реагируем только когда карточка реально открыта.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('mymarketProductCardOverlay').hidden) {
      closeMyMarketProductCard();
    }
    if (e.key === 'Escape' && !document.getElementById('mmCourierCardOverlay').hidden) {
      closeCourierCard();
    }
  });

  // Карточка курьера — модальное окно
  document.getElementById('mmCourierCardClose').addEventListener('click', closeCourierCard);
  document.getElementById('mmCourierCardOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'mmCourierCardOverlay') closeCourierCard();
  });

  // Аналитика — период (7/30 дней) и три подвкладки. Период меняет то,
  // что грузится по факту нового запроса; подвкладки переключают, какая
  // из трёх уже загруженных (или ещё не загруженных) таблиц видна.
  document.getElementById('mmAnalyticsPeriodTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#mmAnalyticsPeriodTabs button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    loadMyMarketAnalytics();
  });
  document.getElementById('mmAnalyticsSubTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#mmAnalyticsSubTabs button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const subtab = btn.dataset.subtab;
    document.getElementById('mmAnalyticsSearchTab').hidden = subtab !== 'search';
    document.getElementById('mmAnalyticsConversionTab').hidden = subtab !== 'conversion';
    document.getElementById('mmAnalyticsSeasonalityTab').hidden = subtab !== 'seasonality';
    loadMyMarketAnalytics();
  });

  // Курьеры — поиск (по мере ввода) и вкладки Активные/Заблокированные —
  // оба фильтруют уже загруженный список на клиенте, без нового запроса.
  document.getElementById('mymarketCouriersSearch').addEventListener('input', () => renderMyMarketCouriersTable());
  document.getElementById('mymarketCouriersStatusTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#mymarketCouriersStatusTabs button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    renderMyMarketCouriersTable();
  });

  // Вкладки внутри карточки товара (Информация/Характеристики/Медиа/Превью)
  document.getElementById('mymarketCardTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    switchMyMarketCardTab(btn.dataset.cardtab);
  });

  // --- Фото: выбор с компьютера/телефона ---
  document.getElementById('mmChoosePhotoBtn').addEventListener('click', () => document.getElementById('mmPhotoFileInput').click());
  document.getElementById('mmPhotoFileInput').addEventListener('change', (e) => {
    if (e.target.files.length) handleMyMarketPhotoFiles(e.target.files);
    e.target.value = '';
  });
  // --- Фото: перетаскивание в зону ---
  const photoDropzone = document.getElementById('mmPhotoDropzone');
  photoDropzone.addEventListener('dragover', (e) => { e.preventDefault(); photoDropzone.classList.add('is-dragover'); });
  photoDropzone.addEventListener('dragleave', () => photoDropzone.classList.remove('is-dragover'));
  photoDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    photoDropzone.classList.remove('is-dragover');
    if (e.dataTransfer.files.length) handleMyMarketPhotoFiles(e.dataTransfer.files);
  });
  // --- Фото: вставка URL ---
  document.getElementById('mmAddPhotoUrlBtn').addEventListener('click', () => {
    const input = document.getElementById('mmPhotoUrlInput');
    const url = input.value.trim();
    if (!url) return;
    if (myMarketCardImages.length >= 10) { alert('Можно не больше 10 фото'); return; }
    myMarketCardImages.push(url);
    renderMyMarketMediaGrid();
    input.value = '';
  });

  // Видео — ТОЛЬКО ссылка, файл не принимается (Vercel режет тело запроса
  // на своей стороне примерно на 4.5 МБ — видео такого размера практически
  // никогда не бывает, поэтому файловую загрузку для видео убрали совсем).
  document.getElementById('mmAddVideoUrlBtn').addEventListener('click', () => {
    const input = document.getElementById('mmVideoUrlInput');
    const url = input.value.trim();
    if (!url) return;
    myMarketCardVideo = url;
    renderMyMarketVideoPreview();
    input.value = '';
  });
}

function switchMyMarketTab(tab) {
  document.querySelectorAll('#mymarketTabs button').forEach((b) => b.classList.remove('is-active'));
  document.querySelector(`#mymarketTabs button[data-tab="${tab}"]`)?.classList.add('is-active');
  MY_MARKET_TABS.forEach((t) => {
    const el = document.getElementById(`mymarket${t.charAt(0).toUpperCase() + t.slice(1)}Tab`);
    if (el) el.hidden = t !== tab;
  });
  if (tab === 'home') loadMyMarketHome();
  if (tab === 'products') loadMyMarketProducts();
  if (tab === 'prices') loadMyMarketPrices();
  if (tab === 'orders') loadMyMarketOrders();
  if (tab === 'analytics') loadMyMarketAnalytics();
  if (tab === 'couriers') loadMyMarketCouriers();
  if (tab === 'finance') loadMyMarketFinance();
}

async function loadMyMarketPage() {
  wireMyMarketTabsOnce();
  await loadMyMarketHome();
}

// ---------------------------------------------------------------------
// Главная — KPI + график за 14 дней (только ShopOrder)
// ---------------------------------------------------------------------
async function loadMyMarketHome() {
  const stats = await api('/shop-admin/dashboard');

  document.getElementById('mymarketKpis').innerHTML = kpiCardsHtml([
    { label: 'Заказано', value: fmtMoney(stats.totalRevenue) },
    { label: 'Заказано, шт', value: fmt.format(stats.totalItems) },
    { label: 'Ждут сборки', value: fmt.format(stats.awaitingAssembly) },
    { label: 'В доставке', value: fmt.format(stats.inDelivery) },
    { label: 'Доставлены', value: fmt.format(stats.delivered), cls: 'pos' },
    { label: 'Отменены/возвраты', value: fmt.format(stats.cancelled), cls: stats.cancelled > 0 ? 'neg' : '' },
  ]);

  const canvas = document.getElementById('mymarketChartCanvas');
  if (typeof Chart === 'undefined' || !canvas) {
    console.warn('Chart.js не загрузился — график My Market временно недоступен.');
    return;
  }
  const labels = stats.chart.map((d) => d.date.slice(5)); // MM-DD
  const counts = stats.chart.map((d) => d.count);
  const revenues = stats.chart.map((d) => d.revenue);

  if (myMarketChartInstance) myMarketChartInstance.destroy();
  myMarketChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'line', label: 'Выручка', data: revenues, borderColor: '#9AA1AC', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 1.5, yAxisID: 'y1' },
        { type: 'bar', label: 'Заказов, шт', data: counts, backgroundColor: 'rgba(59,130,246,0.6)', borderRadius: 3, maxBarThickness: 28 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#6B7280', font: { family: 'Inter', size: 11 } } } },
      scales: {
        x: { ticks: { color: '#9AA1AC', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#EEF0F3' } },
        y: { ticks: { color: '#9AA1AC', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#EEF0F3' } },
        y1: { position: 'right', ticks: { color: '#9AA1AC', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { display: false } },
      },
    },
  });
}

// ---------------------------------------------------------------------
// Товары — список в стиле «Список товаров» Ozon Seller
// ---------------------------------------------------------------------
function myMarketFirstImage(imagesJson) {
  try {
    const arr = imagesJson ? JSON.parse(imagesJson) : [];
    return Array.isArray(arr) && arr[0] ? arr[0] : null;
  } catch {
    return null;
  }
}

async function loadMyMarketProducts() {
  myMarketProductsCache = await api('/products');
  renderMyMarketProductsTable();
}

function myMarketStatusOf(p) {
  if (!p.category || !p.type) return 'nocat';
  return p.shopActive ? 'active' : 'hidden';
}

function renderMyMarketProductsTable() {
  const filter = document.querySelector('#mymarketProductFilterTabs button.is-active')?.dataset.filter || 'active';
  const search = document.getElementById('mymarketProductsSearch').value.trim().toLowerCase();

  let rows = myMarketProductsCache;
  if (filter !== 'all') rows = rows.filter((p) => myMarketStatusOf(p) === filter);
  if (search) rows = rows.filter((p) => p.name.toLowerCase().includes(search) || p.sku.toLowerCase().includes(search));

  const tbody = document.querySelector('#mymarketProductsTable tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="color:var(--text-faint)">Товаров нет</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((p) => {
    const img = myMarketFirstImage(p.images);
    const status = myMarketStatusOf(p);
    const statusHtml = status === 'nocat'
      ? `<span class="mm-status--nocat" title="Нет category или type — нельзя включить «В продаже»">⚠ Без категории</span>`
      : status === 'active'
        ? `<span class="mm-status--active">● В продаже</span>`
        : `<span class="mm-status--hidden">○ Скрыт</span>`;
    return `
    <tr>
      <td>${img ? `<img src="${img}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px" />` : '<span style="color:var(--text-faint);font-size:11px">—</span>'}</td>
      <td class="name-cell">${p.sku}</td>
      <td class="name-cell">${p.name}<br><span style="font-size:10.5px;color:var(--text-faint)">${p.category ?? '—'}${p.type ? ` / ${p.type}` : ''}</span></td>
      <td>${statusHtml}</td>
      <td class="num">${p.shopPrice != null ? fmtMoney(p.shopPrice) : '—'}</td>
      <td class="num">${p.shopOldPrice != null ? fmtMoney(p.shopOldPrice) : '—'}</td>
      <td class="num">${p.shopStock ?? 0}</td>
      <td>${p.shopDelivery === 'rocket' ? '🚀' : p.shopDelivery === 'truck' ? '🚚' : '—'}</td>
      <td class="num" id="mm-reviews-${p.sku}">…</td>
      <td><button class="link-btn" data-action="edit" data-id="${p.id}">✎</button></td>
    </tr>
  `;
  }).join('');

  tbody.querySelectorAll('button[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => openMyMarketProductCard(btn.dataset.id));
  });

  // Число отзывов — один общий запрос по всем sku сразу (не по одному на
  // строку), через отдельный админский эндпоинт без x-app-key.
  loadMyMarketReviewCounts(rows.map((p) => p.sku));
}

async function loadMyMarketReviewCounts(skus) {
  try {
    const counts = await api(`/shop-admin/reviews-count?${qs({ skus: skus.join(',') })}`);
    Object.entries(counts).forEach(([sku, count]) => {
      const el = document.getElementById(`mm-reviews-${sku}`);
      if (el) el.textContent = String(count);
    });
    skus.forEach((sku) => {
      const el = document.getElementById(`mm-reviews-${sku}`);
      if (el && el.textContent === '…') el.textContent = '0';
    });
  } catch {
    document.querySelectorAll('[id^="mm-reviews-"]').forEach((el) => { el.textContent = '—'; });
  }
}

function generateMyMarketSku() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `MM-${rand}`;
}

// Состояние медиа открытой карточки — массив URL фото (порядок важен,
// первое = главное) и URL видео (или null). Живёт, пока карточка открыта.
let myMarketCardImages = [];
let myMarketCardVideo = null;
let myMarketDragFromIndex = null;

function switchMyMarketCardTab(tab) {
  document.querySelectorAll('#mymarketCardTabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.cardtab === tab));
  document.querySelectorAll('.mm-cardtab').forEach((el) => { el.hidden = el.dataset.cardtabPanel !== tab; });
  if (tab === 'preview') renderMyMarketPreviewCard();
}

/** Новый товар витрины — пустая карточка, сгенерированный sku вида MM-xxxxxx.
 *  Артикулы Kaspi/Ozon/WB НЕ подставляются вообще — это отдельный товар
 *  только для My Market, не связанный с другими площадками. */
function openMyMarketNewProductCard() {
  myMarketEditingProductId = null;
  const form = document.getElementById('mymarketProductCardForm');
  form.reset();
  form.elements.id.value = '';
  form.elements.sku.value = generateMyMarketSku();
  form.elements.shopStock.value = 0;
  form.elements.shopActive.checked = false;
  myMarketCardImages = [];
  myMarketCardVideo = null;
  renderMyMarketMediaGrid();
  renderMyMarketVideoPreview();
  document.getElementById('mymarketCardWarning').textContent = 'Новый товар витрины — не связан с Kaspi/Ozon/WB.';
  switchMyMarketCardTab('info');
  document.getElementById('mymarketProductCardOverlay').hidden = false;
}

function openMyMarketProductCard(id) {
  const p = myMarketProductsCache.find((x) => x.id === id);
  if (!p) return;
  myMarketEditingProductId = id;
  const form = document.getElementById('mymarketProductCardForm');
  form.elements.id.value = p.id;
  form.elements.sku.value = p.sku;
  form.elements.name.value = p.name;
  form.elements.shopPrice.value = p.shopPrice ?? '';
  form.elements.shopOldPrice.value = p.shopOldPrice ?? '';
  form.elements.shopCost.value = p.shopCost ?? '';
  form.elements.shopStock.value = p.shopStock ?? 0;
  form.elements.shopDelivery.value = p.shopDelivery ?? '';
  form.elements.category.value = p.category ?? '';
  form.elements.subcategory.value = p.subcategory ?? '';
  form.elements.type.value = p.type ?? '';
  form.elements.description.value = p.description ?? '';
  form.elements.composition.value = p.composition ?? '';
  form.elements.videoUrl.value = p.videoUrl ?? '';
  try { myMarketCardImages = p.images ? JSON.parse(p.images) : []; } catch { myMarketCardImages = []; }
  myMarketCardVideo = p.shopVideo ?? null;
  renderMyMarketMediaGrid();
  renderMyMarketVideoPreview();
  form.elements.shopActive.checked = !!p.shopActive;
  document.getElementById('mymarketCardWarning').textContent = (!p.category || !p.type)
    ? 'Без category и type нельзя включить «В продаже».'
    : '';
  switchMyMarketCardTab('info');
  document.getElementById('mymarketProductCardOverlay').hidden = false;
}

function closeMyMarketProductCard() {
  document.getElementById('mymarketProductCardOverlay').hidden = true;
  myMarketEditingProductId = null;
  myMarketCardImages = [];
  myMarketCardVideo = null;
}

// ---------------------------------------------------------------------
// Медиа: сетка фото с drag-переупорядочиванием, загрузка файлом/URL
// ---------------------------------------------------------------------
function renderMyMarketMediaGrid() {
  const grid = document.getElementById('mmMediaGrid');
  if (!myMarketCardImages.length) {
    grid.innerHTML = `<p style="color:var(--text-faint);font-size:12.5px;grid-column:1/-1">Фото ещё не добавлены</p>`;
    return;
  }
  grid.innerHTML = myMarketCardImages.map((url, i) => `
    <div class="mm-media-item" draggable="true" data-index="${i}">
      ${i === 0 ? '<span class="mm-media-item__main-badge">Главное</span>' : ''}
      <img src="${url}" alt="" />
      <button type="button" class="mm-media-item__remove" data-index="${i}" title="Удалить">✕</button>
    </div>
  `).join('');

  grid.querySelectorAll('.mm-media-item__remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      myMarketCardImages.splice(Number(btn.dataset.index), 1);
      renderMyMarketMediaGrid();
    });
  });

  // Перетаскивание миниатюр для смены порядка (первая = главная).
  grid.querySelectorAll('.mm-media-item').forEach((item) => {
    item.addEventListener('dragstart', () => {
      myMarketDragFromIndex = Number(item.dataset.index);
      item.classList.add('is-dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('is-dragging'));
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('is-dragover'); });
    item.addEventListener('dragleave', () => item.classList.remove('is-dragover'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('is-dragover');
      const toIndex = Number(item.dataset.index);
      if (myMarketDragFromIndex === null || myMarketDragFromIndex === toIndex) return;
      const [moved] = myMarketCardImages.splice(myMarketDragFromIndex, 1);
      myMarketCardImages.splice(toIndex, 0, moved);
      myMarketDragFromIndex = null;
      renderMyMarketMediaGrid();
    });
  });
}

function renderMyMarketVideoPreview() {
  const el = document.getElementById('mmVideoPreview');
  el.innerHTML = myMarketCardVideo
    ? `<video src="${myMarketCardVideo}" controls></video><br><button type="button" class="btn btn--ghost" id="mmRemoveVideoBtn" style="font-size:12px">Убрать видео</button>`
    : '';
  const removeBtn = document.getElementById('mmRemoveVideoBtn');
  if (removeBtn) removeBtn.addEventListener('click', () => { myMarketCardVideo = null; renderMyMarketVideoPreview(); });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]); // без префикса data:...;base64,
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

const MM_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Согласовано с сервером (src/routes/shopMedia.routes.ts) — 2.5 МБ, а не
// изначально заявленные 10, из-за предела Vercel на размер тела запроса.
const MM_IMAGE_MAX_MB = 2.5;

/**
 * Прямой fetch (не через общий хелпер api()) — специально, чтобы показать
 * в статусе загрузки РЕАЛЬНЫЙ текст ошибки от сервера (error + details),
 * а не общее "API error 500", которое раньше скрывало настоящую причину
 * (например, PayloadTooLargeError, замаскированный под "внутреннюю ошибку").
 */
async function uploadMyMarketFile(file) {
  if (!MM_IMAGE_TYPES.includes(file.type)) {
    throw new Error(`Формат ${file.type || '(неизвестен)'} не поддерживается — нужен JPEG/PNG/WEBP`);
  }
  if (file.size > MM_IMAGE_MAX_MB * 1024 * 1024) {
    throw new Error(`Файл слишком большой: ${(file.size / 1024 / 1024).toFixed(1)} МБ, максимум ${MM_IMAGE_MAX_MB} МБ`);
  }
  const dataBase64 = await readFileAsBase64(file);
  const res = await fetch('/api/shop/admin/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'image', filename: file.name, contentType: file.type, dataBase64 }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* тело не JSON — обработаем ниже по res.ok/статусу */ }
  if (!res.ok) {
    // Показываем ИМЕННО то, что прислал сервер — error и details как есть,
    // а не завёрнутое/урезанное сообщение.
    const errText = body?.error ?? `HTTP ${res.status}`;
    const detailsText = body?.details ? ` — ${typeof body.details === 'string' ? body.details : JSON.stringify(body.details)}` : '';
    const err = new Error(errText + detailsText);
    err.isBlobMissing = body?.error === 'добавьте Blob';
    throw err;
  }
  return body.url;
}

async function handleMyMarketPhotoFiles(files) {
  const statusEl = document.getElementById('mmPhotoUploadStatus');
  const list = Array.from(files);
  if (myMarketCardImages.length + list.length > 10) {
    statusEl.textContent = `Можно не больше 10 фото (сейчас ${myMarketCardImages.length}, пытаешься добавить ещё ${list.length}).`;
    statusEl.style.color = 'var(--loss)';
    return;
  }
  for (const file of list) {
    statusEl.textContent = `Загружаю ${file.name}…`;
    statusEl.style.color = 'var(--text-faint)';
    try {
      const url = await uploadMyMarketFile(file);
      myMarketCardImages.push(url);
      renderMyMarketMediaGrid();
      statusEl.textContent = '';
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.style.color = err.isBlobMissing ? 'var(--warn)' : 'var(--loss)';
    }
  }
}

function renderMyMarketPreviewCard() {
  const form = document.getElementById('mymarketProductCardForm');
  const name = form.elements.name.value.trim() || '(без названия)';
  const price = form.elements.shopPrice.value;
  const oldPrice = form.elements.shopOldPrice.value;
  const img = myMarketCardImages[0];
  document.getElementById('mmPreviewCard').innerHTML = `
    ${img ? `<img src="${img}" alt="" />` : `<div style="aspect-ratio:1/1;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-faint);font-size:12px">нет фото</div>`}
    <div class="mm-preview-body">
      <div class="mm-preview-name">${name}</div>
      <div>
        <span class="mm-preview-price">${price ? fmtMoney(Number(price)) : '—'}</span>
        ${oldPrice ? `<span class="mm-preview-oldprice">${fmtMoney(Number(oldPrice))}</span>` : ''}
      </div>
    </div>
  `;
}

async function saveMyMarketProductCard(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.elements.id.value;
  const sku = form.elements.sku.value.trim();
  const category = form.elements.category.value.trim() || null;
  const type = form.elements.type.value.trim() || null;
  const shopActive = form.elements.shopActive.checked;

  if (shopActive && (!category || !type)) {
    document.getElementById('mymarketCardWarning').textContent = 'Нельзя включить «В продаже» без category и type — заполни оба поля.';
    switchMyMarketCardTab('attrs');
    return;
  }

  const payload = {
    name: form.elements.name.value.trim(),
    shopPrice: form.elements.shopPrice.value === '' ? null : Number(form.elements.shopPrice.value),
    shopOldPrice: form.elements.shopOldPrice.value === '' ? null : Number(form.elements.shopOldPrice.value),
    shopCost: form.elements.shopCost.value === '' ? null : Number(form.elements.shopCost.value),
    shopStock: form.elements.shopStock.value === '' ? 0 : Number(form.elements.shopStock.value),
    shopDelivery: form.elements.shopDelivery.value || null,
    category,
    subcategory: form.elements.subcategory.value.trim() || null,
    type,
    description: form.elements.description.value.trim() || null,
    composition: form.elements.composition.value.trim() || null,
    images: myMarketCardImages.length ? JSON.stringify(myMarketCardImages) : null,
    shopVideo: myMarketCardVideo || null,
    videoUrl: form.elements.videoUrl.value.trim() || null,
    shopActive,
  };

  try {
    if (id) {
      await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      // Новый товар витрины — явно НЕ подставляем kaspiSku/ozonOfferId/
      // wbArticle, это отдельный товар только для My Market.
      if (!sku) { document.getElementById('mymarketCardWarning').textContent = 'Не удалось сгенерировать SKU, попробуй ещё раз открыть карточку.'; return; }
      await api('/products', { method: 'POST', body: JSON.stringify({ sku, costPrice: 0, ...payload }) });
    }
    closeMyMarketProductCard();
    await loadMyMarketProducts();
  } catch (err) {
    document.getElementById('mymarketCardWarning').textContent = 'Не удалось сохранить: ' + err.message;
  }
}


// ---------------------------------------------------------------------
// Цены и акции — только товары «В продаже» + баннеры (4 слота)
// ---------------------------------------------------------------------
async function loadMyMarketPrices() {
  const products = await api('/products');
  myMarketProductsCache = products;

  // ТОЛЬКО товары "В продаже" (shopActive=true) — не весь каталог
  // Kaspi/Ozon/WB. Раньше сюда попадали любые товары с намёком на витрину
  // (категория/цена заданы) — теперь строго по фактическому статусу.
  const rows = products.filter((p) => p.shopActive);

  const tableWrap = document.getElementById('mymarketPricesTableWrap');
  const emptyEl = document.getElementById('mymarketPricesEmpty');

  if (!rows.length) {
    tableWrap.hidden = true;
    emptyEl.hidden = false;
    emptyEl.innerHTML = `
      <p class="panel__hint">Нет товаров в продаже.</p>
      <button class="btn btn--accent" id="mymarketPricesGoProductsBtn">Перейти в «Товары»</button>
    `;
    document.getElementById('mymarketPricesGoProductsBtn').addEventListener('click', () => switchMyMarketTab('products'));
  } else {
    tableWrap.hidden = false;
    emptyEl.hidden = true;

    const tbody = document.querySelector('#mymarketPricesTable tbody');
    tbody.innerHTML = rows.map((p) => `
      <tr data-id="${p.id}">
        <td class="name-cell">${p.sku}</td>
        <td class="name-cell">${p.name}</td>
        <td class="num"><input class="cost-input" type="number" step="1" data-field="shopPrice" value="${p.shopPrice ?? ''}" placeholder="—" style="width:90px" /></td>
        <td class="num"><input class="cost-input" type="number" step="1" data-field="shopOldPrice" value="${p.shopOldPrice ?? ''}" placeholder="—" style="width:90px" /></td>
        <td class="num"><input class="cost-input" type="number" step="1" data-field="shopStock" value="${p.shopStock ?? 0}" style="width:70px" /></td>
        <td class="num"><input class="cost-input" type="number" step="1" data-field="shopCost" value="${p.shopCost ?? ''}" placeholder="нет закупа" style="width:90px" /></td>
        <td class="num" data-profit-cell>—</td>
        <td class="num" data-margin-cell>—</td>
      </tr>
    `).join('');

    // Сохранение по blur (уход с поля), а не по каждому "change" —
    // ровно как просили, ведёт себя чуть мягче при быстром табе между полями.
    // Себестоимость сохраняется точно так же, как цена (тот же путь).
    tbody.querySelectorAll('[data-field]').forEach((el) => {
      el.addEventListener('blur', async () => {
        const id = el.closest('tr').dataset.id;
        const field = el.dataset.field;
        const value = el.value === '' ? null : Number(el.value);
        try {
          await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) });
        } catch (err) {
          alert('Не удалось сохранить: ' + err.message);
        }
      });
      // Живой пересчёт прибыли/маржи при вводе — не дожидаясь сохранения,
      // чтобы продавец сразу видел эффект от цены/себестоимости.
      el.addEventListener('input', () => recalcMyMarketPriceRow(el.closest('tr')));
    });

    // Первичный расчёт при отрисовке таблицы.
    tbody.querySelectorAll('tr').forEach((tr) => recalcMyMarketPriceRow(tr));
  }

  await renderMyMarketBannerSlots();
}

// Логистика APP пока фиксированная — 2000 ₸ с единицы (позже можно брать
// ShopOrder.logisticsCost по факту заказа). Налог APP — фиксированные 4%,
// не общая настраиваемая ставка (та же, что и на бэкенде в getSummary/
// getSummaryByMarketplace для marketplace=APP, см. analytics.routes.ts).
const MM_APP_LOGISTICS_PER_UNIT = 2000;
const MM_APP_TAX_RATE = 0.04;

/**
 * Прибыль = цена − себестоимость − налог(4%) − логистика(2000 фикс).
 * Пока себестоимость не заполнена — честно показываем "нет закупа", а не
 * считаем её нулём (иначе прибыль/маржа выглядели бы завышенными).
 */
function recalcMyMarketPriceRow(tr) {
  const priceInput = tr.querySelector('[data-field="shopPrice"]');
  const costInput = tr.querySelector('[data-field="shopCost"]');
  const profitCell = tr.querySelector('[data-profit-cell]');
  const marginCell = tr.querySelector('[data-margin-cell]');

  const price = priceInput.value === '' ? null : Number(priceInput.value);
  const cost = costInput.value === '' ? null : Number(costInput.value);

  if (price == null) {
    profitCell.textContent = '—';
    marginCell.textContent = '—';
    return;
  }
  if (cost == null) {
    profitCell.textContent = 'нет закупа';
    profitCell.style.color = 'var(--text-faint)';
    marginCell.textContent = '—';
    return;
  }

  const tax = price * MM_APP_TAX_RATE;
  const profit = price - cost - tax - MM_APP_LOGISTICS_PER_UNIT;
  const marginPct = price > 0 ? (profit / price) * 100 : 0;

  profitCell.textContent = fmtMoney(profit);
  profitCell.style.color = profit >= 0 ? 'var(--accent)' : 'var(--loss)';
  marginCell.textContent = fmtPct(marginPct);
  marginCell.style.color = marginPct >= 0 ? 'var(--accent)' : 'var(--loss)';
}

/**
 * Баннеры — отдельная сущность ShopBanner (не поле товара): своя картинка
 * (URL), заголовок, подзаголовок, ссылка на sku ИЛИ категорию, вкл/выкл.
 * 4 фиксированных слота, сервер всегда отдаёт ровно 4 записи.
 */
async function renderMyMarketBannerSlots() {
  const container = document.getElementById('mymarketBannerSlots');
  const banners = await api('/shop-admin/banners');

  container.innerHTML = banners.map((b) => `
    <div class="banner-slot" data-slot="${b.slot}">
      ${b.imageUrl ? `<img src="${b.imageUrl}" alt="" onerror="this.style.display='none'" />` : `<div style="width:100%;height:90px;background:var(--bg);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--text-faint);font-size:11px">нет фото</div>`}
      <input type="text" placeholder="URL фото баннера" class="cost-input mm-banner-image" value="${b.imageUrl ?? ''}" />
      <input type="text" placeholder="Заголовок" class="cost-input mm-banner-title" value="${b.title ?? ''}" />
      <input type="text" placeholder="Подзаголовок" class="cost-input mm-banner-subtitle" value="${b.subtitle ?? ''}" />
      <div style="display:flex;gap:6px">
        <select class="cost-input mm-banner-linktype" style="flex:1">
          <option value="sku" ${b.linkType === 'sku' || !b.linkType ? 'selected' : ''}>Товар (SKU)</option>
          <option value="category" ${b.linkType === 'category' ? 'selected' : ''}>Категория</option>
        </select>
        <input type="text" placeholder="sku или категория" class="cost-input mm-banner-linkvalue" value="${b.linkValue ?? ''}" style="flex:1" />
      </div>
      <label style="display:flex;align-items:center;gap:6px;flex-direction:row;font-size:12px;color:var(--text-muted)">
        <input type="checkbox" class="mm-banner-active" style="width:auto" ${b.active ? 'checked' : ''} /> Включён (виден в приложении)
      </label>
      <button class="btn btn--ghost mm-banner-save" style="font-size:12px">Сохранить слот ${b.slot + 1}</button>
    </div>
  `).join('');

  container.querySelectorAll('.banner-slot').forEach((slotEl) => {
    slotEl.querySelector('.mm-banner-save').addEventListener('click', async () => {
      const slot = slotEl.dataset.slot;
      const payload = {
        imageUrl: slotEl.querySelector('.mm-banner-image').value.trim() || null,
        title: slotEl.querySelector('.mm-banner-title').value.trim() || null,
        subtitle: slotEl.querySelector('.mm-banner-subtitle').value.trim() || null,
        linkType: slotEl.querySelector('.mm-banner-linktype').value,
        linkValue: slotEl.querySelector('.mm-banner-linkvalue').value.trim() || null,
        active: slotEl.querySelector('.mm-banner-active').checked,
      };
      try {
        await api(`/shop-admin/banners/${slot}`, { method: 'PUT', body: JSON.stringify(payload) });
        await renderMyMarketBannerSlots();
      } catch (err) {
        alert('Не удалось сохранить баннер: ' + err.message);
      }
    });
  });
}


// ---------------------------------------------------------------------
// Заказы — ShopOrder, статусы, печать накладной
// ---------------------------------------------------------------------
const MY_MARKET_STATUS_LABELS = {
  pending_payment: 'Ожидает оплаты',
  paid: 'Оплачен',
  picked: 'Курьер забрал',
  in_transit: 'В пути',
  delivered: 'Выдан',
  cancelled: 'Отменён',
};

async function loadMyMarketOrders() {
  const status = document.querySelector('#mymarketOrderStatusTabs button.is-active')?.dataset.status || '';
  const orders = await api(`/shop-admin/orders${status ? `?status=${status}` : ''}`);
  const tbody = document.querySelector('#mymarketOrdersTable tbody');
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="color:var(--text-faint)">Заказов нет</td></tr>`;
    return;
  }
  tbody.innerHTML = orders.map((o) => {
    const address = [o.city, o.street, o.house, o.apartment ? `кв. ${o.apartment}` : ''].filter(Boolean).join(', ');
    const isCancelled = o.status === 'cancelled';
    // Отменённый заказ — накладная не нужна: кнопка серая, неактивная,
    // без обработчика клика (не просто визуально приглушена).
    const waybillCell = isCancelled
      ? `<button class="link-btn" disabled style="color:var(--text-faint);cursor:not-allowed" title="Заказ отменён">🖨 Накладная</button>`
      : `<button class="link-btn" data-action="print" data-id="${o.id}">🖨 Накладная</button>`;
    const statusLabel = MY_MARKET_STATUS_LABELS[o.status] ?? o.status;
    const statusCell = o.status === 'delivered'
      ? `<span style="color:var(--accent);font-weight:600">● ${statusLabel}</span>`
      : (o.status === 'picked' || o.status === 'in_transit')
        ? `<span style="color:#2563eb;font-weight:600">● ${statusLabel}</span>`
        : o.status === 'pending_payment'
          ? `${statusLabel}<br><button class="link-btn" data-action="mark-paid" data-id="${o.id}" style="font-size:11px;margin-top:2px">Отметить оплаченным</button>`
          : statusLabel;
    // Курьер + сумма к выплате — только у доставленных заказов (courier/
    // payout приходят из include на бэкенде, у остальных статусов null).
    const courierCell = o.courier
      ? `<div style="font-size:11px;line-height:1.5">
          <div>${o.courier.name}</div>
          <div style="color:var(--text-faint)">${o.courier.phone}</div>
          <div style="color:var(--text-faint)">${o.courier.requisitesType === 'kaspi' ? 'Kaspi' : 'Карта'}: ${o.courier.requisitesValue}</div>
          ${o.payout ? `<div style="margin-top:2px;font-weight:600">${fmtMoney(o.payout.amount)}</div>` : ''}
          ${o.payout && o.payout.status === 'pending'
            ? `<button class="link-btn" data-action="payout" data-order-id="${o.id}" style="font-size:11px">Выплачено</button>`
            : o.payout ? `<span style="color:var(--accent);font-size:11px">✓ выплачено</span>` : ''}
        </div>`
      : `<span style="color:var(--text-faint)">—</span>`;
    return `
    <tr>
      <td class="name-cell">${o.number}</td>
      <td>${fmtOrderDateTime(o.createdAt)}</td>
      <td class="name-cell">${o.customerName}</td>
      <td>${o.phone}</td>
      <td class="name-cell" style="font-size:11px">${address}</td>
      <td class="num">${fmtMoney(o.total)}</td>
      <td>${statusCell}</td>
      <td>${o.pickupCode}</td>
      <td>${courierCell}</td>
      <td>${waybillCell}</td>
    </tr>
  `;
  }).join('');

  tbody.querySelectorAll('button[data-action="mark-paid"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Отметить заказ оплаченным? Пока нет эквайринга — это единственный способ протестировать дальнейший путь заказа.')) return;
      btn.disabled = true;
      try {
        await api(`/shop-admin/orders/${btn.dataset.id}/mark-paid`, { method: 'POST' });
        await loadMyMarketOrders();
      } catch (err) {
        alert('Не удалось отметить оплаченным: ' + err.message);
        btn.disabled = false;
      }
    });
  });

  tbody.querySelectorAll('button[data-action="payout"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/shop-admin/payouts/${btn.dataset.orderId}/paid`, { method: 'POST' });
        await loadMyMarketOrders();
      } catch (err) {
        alert('Не удалось отметить выплату: ' + err.message);
        btn.disabled = false;
      }
    });
  });

  tbody.querySelectorAll('button[data-action="print"]').forEach((btn) => {
    btn.addEventListener('click', () => downloadMyMarketWaybill(btn.dataset.id));
  });
}

/**
 * Кнопка «Накладная» — качает PDF-наклейку 75×120мм с сервера
 * (GET /api/shop/admin/orders/:id/waybill, без x-app-key — это админский
 * путь). Никакого HTML-окна с ценой/суммой/кодом выдачи больше нет — та
 * версия показывала то, что на наклейке печатать нельзя.
 */
function downloadMyMarketWaybill(orderId) {
  window.open(`/api/shop/admin/orders/${orderId}/waybill`, '_blank');
}

// ---------------------------------------------------------------------
// Аналитика витрины — период 7/30 дней, три подвкладки. Только канал APP.
// ---------------------------------------------------------------------
function mmAnalyticsPeriodDays() {
  return document.querySelector('#mmAnalyticsPeriodTabs button.is-active')?.dataset.days === '30' ? 30 : 7;
}

async function loadMyMarketAnalytics() {
  const subtab = document.querySelector('#mmAnalyticsSubTabs button.is-active')?.dataset.subtab || 'search';
  if (subtab === 'search') return loadMyMarketAnalyticsSearch();
  if (subtab === 'conversion') return loadMyMarketAnalyticsConversion();
  if (subtab === 'seasonality') return loadMyMarketAnalyticsSeasonality();
}

async function loadMyMarketAnalyticsSearch() {
  const days = mmAnalyticsPeriodDays();
  const rows = await api(`/shop-admin/analytics/search?days=${days}`);
  const tbody = document.querySelector('#mmAnalyticsSearchTable tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-faint)">Поисковых запросов за этот период нет</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => {
    // Города этого запроса — уже только из белого списка, только >0,
    // отсортированы по числу людей убыв. (см. бэкенд). Формат ровно как
    // просили: "Алматы 12 · Астана 5 · Павлодар 1 · Всего по РК: 18".
    const cityParts = r.cityBreakdown.map((c) => `${c.city} ${c.count}`);
    let citySummary = cityParts.length ? cityParts.join(' · ') : '';
    citySummary += (citySummary ? ' · ' : '') + `Всего по РК: ${r.totalRk}`;
    if (r.noCityCount > 0) citySummary += ` · без города: ${r.noCityCount}`;

    return `
    <tr>
      <td class="name-cell">${r.query}</td>
      <td class="num">${fmt.format(r.searchCount)}</td>
      <td class="num">${fmt.format(r.uniquePeople)}</td>
      <td class="num">${fmt.format(r.orderedAfterSearch)}</td>
      <td class="num">${fmtMoney(r.orderedRevenue)}</td>
      <td class="num">${r.avgResultsCount ?? '—'}</td>
      <td class="num">${fmt.format(r.zeroResultsCount)}</td>
    </tr>
    <tr>
      <td colspan="7" style="padding:2px 4px 10px;color:var(--text-faint);font-size:11.5px;border-top:none">${citySummary}</td>
    </tr>
  `;
  }).join('');
}

async function loadMyMarketAnalyticsConversion() {
  const days = mmAnalyticsPeriodDays();
  const rows = await api(`/shop-admin/analytics/conversion?days=${days}`);
  const tbody = document.querySelector('#mmAnalyticsConversionTable tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-faint)">Нет событий по товарам за этот период</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="name-cell">${r.name}</td>
      <td class="num">${fmt.format(r.views)}</td>
      <td class="num">${fmt.format(r.cart)}</td>
      <td class="num">${fmt.format(r.orders)}</td>
      <td class="num">${fmt.format(r.payments)}</td>
      <td class="num">${fmtPct(r.cartPct)}</td>
      <td class="num">${fmtPct(r.orderPct)}</td>
    </tr>
  `).join('');
}

async function loadMyMarketAnalyticsSeasonality() {
  const days = mmAnalyticsPeriodDays();
  const data = await api(`/shop-admin/analytics/seasonality?days=${days}`);

  const dailyBody = document.querySelector('#mmAnalyticsDailyTable tbody');
  dailyBody.innerHTML = data.daily.length
    ? data.daily.map((d) => `
        <tr>
          <td>${d.date}</td>
          <td class="num">${fmt.format(d.searches)}</td>
          <td class="num">${fmt.format(d.cart)}</td>
          <td class="num">${fmt.format(d.orders)}</td>
          <td class="num">${fmtMoney(d.paidRevenue)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="5" style="color:var(--text-faint)">Нет данных</td></tr>`;

  const citiesBody = document.querySelector('#mmAnalyticsCitiesTable tbody');
  citiesBody.innerHTML = data.cities.length
    ? data.cities.map((c) => `
        <tr>
          <td>${c.city}</td>
          <td class="num">${fmt.format(c.searches)}</td>
          <td class="num">${fmt.format(c.uniquePeople)}</td>
          <td class="num">${fmt.format(c.orders)}</td>
          <td class="num">${fmtMoney(c.revenue)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="5" style="color:var(--text-faint)">Нет данных</td></tr>`;
}

// ---------------------------------------------------------------------
// Курьеры — таблица + карточка с фото (только здесь, не в API курьера)
// ---------------------------------------------------------------------
let myMarketCouriersCache = [];

async function loadMyMarketCouriers() {
  const couriers = await api('/shop-admin/couriers');
  myMarketCouriersCache = couriers;
  renderMyMarketCouriersTable();
}

/** Фильтрует уже загруженный список по вкладке (active=true/false) и
 *  поисковой строке (имя, фамилия, телефон, ИИН) — без обращения к
 *  серверу заново, список уже есть в myMarketCouriersCache. */
function renderMyMarketCouriersTable() {
  const statusTab = document.querySelector('#mymarketCouriersStatusTabs button.is-active')?.dataset.status || 'active';
  const wantActive = statusTab === 'active';
  const query = document.getElementById('mymarketCouriersSearch').value.trim().toLowerCase();

  let rows = myMarketCouriersCache.filter((c) => c.active === wantActive);
  if (query) {
    rows = rows.filter((c) =>
      c.name.toLowerCase().includes(query) ||
      c.phone.toLowerCase().includes(query) ||
      (c.iin ?? '').toLowerCase().includes(query),
    );
  }

  const tbody = document.querySelector('#mymarketCouriersTable tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--text-faint)">${wantActive ? 'Активных курьеров нет' : 'Заблокированных курьеров нет'}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((c) => `
    <tr data-id="${c.id}" style="cursor:pointer">
      <td>${c.facePhotoUrl ? `<img src="${c.facePhotoUrl}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:50%" />` : '<span style="color:var(--text-faint);font-size:11px">—</span>'}</td>
      <td class="name-cell">${c.name}</td>
      <td>${c.iin ?? '—'}</td>
      <td>${c.phone}</td>
      <td class="name-cell" style="font-size:11px">${c.address ?? '—'}</td>
      <td>${c.vehicle ?? '—'}</td>
      <td style="font-size:11px">${c.requisitesType === 'kaspi' ? 'Kaspi' : 'Карта'}: ${c.requisitesValue}</td>
      <td style="font-size:11px">${c.agreeContractAt ? fmtOrderDateTime(c.agreeContractAt) : '—'}</td>
      <td>${c.active ? '<span style="color:var(--accent)">● Активен</span>' : '<span style="color:var(--loss)">● Заблокирован</span>'}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => openCourierCard(tr.dataset.id));
  });
}

function openCourierCard(id) {
  const c = myMarketCouriersCache.find((x) => x.id === id);
  if (!c) return;
  document.getElementById('mmCourierCardBody').innerHTML = `
    <div style="display:flex;gap:14px;margin-bottom:14px">
      ${c.facePhotoUrl ? `<img src="${c.facePhotoUrl}" alt="Лицо" style="width:140px;height:140px;object-fit:cover;border-radius:10px" />` : ''}
      ${c.idPhotoUrl ? `<img src="${c.idPhotoUrl}" alt="Удостоверение" style="width:220px;height:140px;object-fit:cover;border-radius:10px" />` : ''}
    </div>
    <div class="form-grid">
      <div><strong>ФИО:</strong> ${c.name}</div>
      <div><strong>ИИН:</strong> ${c.iin ?? '—'}</div>
      <div><strong>Телефон:</strong> ${c.phone}</div>
      <div><strong>Адрес:</strong> ${c.address ?? '—'}</div>
      <div><strong>Авто:</strong> ${c.vehicle ?? '—'}</div>
      <div><strong>Реквизиты:</strong> ${c.requisitesType === 'kaspi' ? 'Kaspi' : 'Карта'}: ${c.requisitesValue}</div>
      <div><strong>Согласие:</strong> ${c.agreeContractAt ? fmtOrderDateTime(c.agreeContractAt) : '—'}</div>
      <div><strong>Статус:</strong> ${c.active ? 'Активен' : 'Заблокирован'}</div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:10px">
      <button class="btn ${c.active ? 'btn--ghost' : 'btn--accent'}" id="mmCourierBlockBtn" style="${c.active ? 'color:var(--loss)' : ''}">
        ${c.active ? 'Заблокировать' : 'Разблокировать'}
      </button>
    </div>
  `;
  document.getElementById('mmCourierBlockBtn').addEventListener('click', async () => {
    try {
      await api(`/shop-admin/couriers/${c.id}/block`, { method: 'POST', body: JSON.stringify({ active: !c.active }) });
      closeCourierCard();
      await loadMyMarketCouriers();
    } catch (err) {
      alert('Не удалось изменить статус курьера: ' + err.message);
    }
  });
  document.getElementById('mmCourierCardOverlay').hidden = false;
}

function closeCourierCard() {
  document.getElementById('mmCourierCardOverlay').hidden = true;
}

// ---------------------------------------------------------------------
// Финансы APP — только канал APP, не смешивается с Ozon/Kaspi/WB
// ---------------------------------------------------------------------
async function loadMyMarketFinance() {
  const to = todayISO();
  const from = almatyDateDaysAgo(30);
  const [summary, byProduct] = await Promise.all([
    api(`/analytics/summary?${qs({ from, to, marketplace: 'APP' })}`),
    api(`/analytics/by-product?${qs({ from, to, marketplace: 'APP' })}`),
  ]);

  document.getElementById('mymarketFinanceKpis').innerHTML = kpiCardsHtml([
    { label: 'Выручка APP (30д)', value: fmtMoney(summary.revenue) },
    { label: '− Налог 4%', value: fmtMoney(summary.taxAmount) },
    { label: '− Логистика', value: fmtMoney(summary.logisticsCost) },
    { label: '− Себестоимость проданных', value: fmtMoney(summary.cogs) },
    { label: '= Прибыль APP', value: fmtMoney(summary.payout), cls: summary.payout >= 0 ? 'pos' : 'neg', accent: true },
    { label: 'Маржа %', value: summary.revenue > 0 ? fmtPct((summary.payout / summary.revenue) * 100) : '—', cls: summary.payout >= 0 ? 'pos' : 'neg' },
  ]);

  const tbody = document.querySelector('#mymarketFinanceTable tbody');
  if (!byProduct.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--text-faint)">Продаж через My Market за последние 30 дней нет</td></tr>`;
    return;
  }
  tbody.innerHTML = byProduct.map((p) => `
    <tr>
      <td class="name-cell">${p.name}</td>
      <td class="num">${fmt.format(p.quantity)}</td>
      <td class="num">${fmtMoney(p.revenue)}</td>
      <td class="num">${fmtMoney(p.cogs)}</td>
      <td class="num">${fmtMoney(p.commission)}</td>
      <td class="num">${fmtMoney(p.logistics)}</td>
      <td class="num ${p.netProfit >= 0 ? 'pos' : 'neg'}">${fmtMoney(p.netProfit)}</td>
      <td class="num ${p.marginPct >= 0 ? 'pos' : 'neg'}">${fmtPct(p.marginPct)}</td>
    </tr>
  `).join('');
}

// ---------------------------------------------------------------------
// Загрузка Excel — только My Market, жёсткие английские названия колонок
// ---------------------------------------------------------------------
function downloadMyMarketTemplate() {
  const headers = [
    'Артикул *', 'Название *', 'Категория *', 'Подкатегория', 'Тип *', 'Код модели', 'Бренд', 'Цвет', 'Размер', 'Пол',
    'Цена на витрине, ₸ *', 'Цена до скидки, ₸', 'Остаток, шт *', 'Доставка', 'В продаже',
    'Ссылки на фото', 'Видео', 'Описание', 'Состав / комплектация',
  ];
  const exampleRows = [
    ['SKU-001', 'Шампунь укрепляющий', 'Красота', 'Уход за волосами', 'Шампунь', '', 'BrandX', '', '', '', 4990, 6990, 25, 'ракета', 'да', 'https://example.com/1.jpg|https://example.com/2.jpg', '', 'Описание товара', 'Состав товара'],
    ['SKU-002', 'Бюстгальтер спортивный', 'Одежда', 'Бельё', 'Бюстгальтер', 'BR-100', 'BrandZ', 'Чёрный', 'M', 'женский', 8990, '', 12, 'грузовик', 'да', 'https://example.com/3.jpg', 'https://example.com/video.mp4', '', ''],
    ['SKU-003', 'Блендер погружной', 'Бытовая техника', '', 'Блендер', '', 'BrandY', '', '', '', 15990, '', 8, 'грузовик', 'да', 'https://example.com/4.jpg', '', '', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Товары');
  XLSX.writeFile(wb, 'my-market-template.xlsx');
}

/**
 * Псевдонимы колонок — русские (основные, из шаблона листа «Товары») +
 * старые английские и старые русские (для обратной совместимости — и
 * прошлый шаблон без единиц измерения, и совсем старый английский, оба
 * по-прежнему принимаются). Звёздочку "*" в заголовке (маркер "обязательно"
 * в шаблоне) при сопоставлении отбрасываем.
 */
const MM_UPLOAD_COLUMN_ALIASES = {
  sku: ['sku', 'артикул'],
  name: ['name', 'название'],
  category: ['category', 'категория'],
  subcategory: ['subcategory', 'подкатегория'],
  type: ['type', 'тип'],
  model: ['код модели', 'модель'],
  brand: ['brand', 'бренд'],
  color: ['color', 'цвет'],
  size: ['size', 'размер'],
  gender: ['gender', 'пол'],
  shopPrice: ['shopprice', 'цена на витрине', 'цена на витрине, ₸'],
  shopOldPrice: ['shopoldprice', 'цена до скидки', 'цена до скидки, ₸'],
  shopStock: ['shopstock', 'остаток', 'остаток, шт'],
  shopDelivery: ['shopdelivery', 'доставка'],
  shopActive: ['shopactive', 'в продаже'],
  images: ['images', 'ссылки на фото'],
  description: ['description', 'описание'],
  composition: ['composition', 'состав', 'состав / комплектация'],
  videoUrl: ['videourl', 'видео'],
};

/**
 * Видео из Excel — строго http(s)-ссылка на .mp4/.webm. Если ячейка не
 * похожа на такую ссылку (мусор, текст, пустая) — просто игнорируем поле
 * (не заполняем videoUrl), НЕ отклоняем строку целиком и не роняем загрузку.
 */
function mmParseVideoUrl(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  return /^https?:\/\/.+\.(mp4|webm)(\?.*)?$/i.test(v) ? v : null;
}

function mmNormalizeHeaderCell(cell) {
  return String(cell ?? '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ') // схлопываем повторяющиеся пробелы — устойчивее к мелким расхождениям в файле
    .trim()
    .toLowerCase();
}

function mmParseDelivery(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'ракета' || v === 'rocket') return 'rocket';
  if (v === 'грузовик' || v === 'truck') return 'truck';
  return null;
}

function mmParseActive(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return true; // по умолчанию — включено, если колонку вообще не заполнили
  return v === 'да' || v === 'true' || v === '1';
}

function mmParseImages(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  // Уже готовый JSON-массив (старые файлы/API) — оставляем как есть.
  if (v.startsWith('[')) {
    try { JSON.parse(v); return v; } catch { /* не похоже на валидный JSON — разбираем как список ниже */ }
  }
  // Разделитель — "|" ИЛИ перевод строки (в одной ячейке Excel можно
  // вставить перенос строки через Alt+Enter) — принимаем оба варианта.
  const urls = v.split(/[|\n\r]+/).map((s) => s.trim()).filter(Boolean);
  return urls.length ? JSON.stringify(urls) : null;
}

/**
 * Собирает финальное описание товара: исходный текст "Описание" плюс,
 * если заполнены, подписанные строки по Коду модели/Бренду/Цвету/Размеру/
 * Полу — так эти данные не теряются, хотя отдельных полей под них в базе
 * пока нет (как и договаривались — потом можно сделать карточку на модель
 * с выбором размера, эти строки легко парсить обратно по префиксу).
 */
function mmComposeDescription(baseDescription, extras) {
  const lines = [];
  if (baseDescription) lines.push(baseDescription);
  if (extras.model) lines.push(`Модель: ${extras.model}`);
  if (extras.brand) lines.push(`Бренд: ${extras.brand}`);
  if (extras.color) lines.push(`Цвет: ${extras.color}`);
  if (extras.size) lines.push(`Размер: ${extras.size}`);
  if (extras.gender) lines.push(`Пол: ${extras.gender}`);
  return lines.length ? lines.join('\n') : null;
}

function mmParseNum(raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

/** Разбирает лист (массив объектов от XLSX/Papa с сырыми заголовками) в
 *  { accepted, rejected } — БЕЗ обращения к серверу, ничего не пишет в базу.
 *  accepted — готовые к отправке объекты, rejected — { sku, name, reason }. */
function mmClassifyRows(rawRows) {
  // Строим карту "нормализованный заголовок -> внутреннее имя поля" один раз.
  const headerToField = {};
  for (const [field, aliases] of Object.entries(MM_UPLOAD_COLUMN_ALIASES)) {
    aliases.forEach((a) => { headerToField[a] = field; });
  }

  const accepted = [];
  const rejected = [];

  rawRows.forEach((row, idx) => {
    const norm = {};
    Object.keys(row).forEach((k) => {
      const field = headerToField[mmNormalizeHeaderCell(k)];
      if (field) norm[field] = row[k];
    });

    const sku = norm.sku != null ? String(norm.sku).trim() : '';
    const name = norm.name != null ? String(norm.name).trim() : '';
    const category = norm.category != null ? String(norm.category).trim() : '';
    const type = norm.type != null ? String(norm.type).trim() : '';
    const shopPrice = mmParseNum(norm.shopPrice);
    const shopStock = mmParseNum(norm.shopStock);

    // Полностью пустая строка (например, хвост файла) — тихо пропускаем,
    // это не "отклонённый товар", а просто пустое место в таблице.
    const isBlankRow = !sku && !name && !category && !type && norm.shopPrice == null && norm.shopStock == null;
    if (isBlankRow) return;

    const missing = [];
    if (!sku) missing.push('нет артикула');
    if (!name) missing.push('нет названия');
    if (!category) missing.push('нет категории');
    if (!type) missing.push('нет типа');
    if (shopPrice == null) missing.push('нет цены на витрине');
    if (shopStock == null) missing.push('нет остатка');

    if (missing.length) {
      rejected.push({ sku: sku || `строка ${idx + 2}`, name: name || '—', reason: missing.join(', ') });
      return;
    }

    accepted.push({
      sku,
      name,
      category,
      subcategory: norm.subcategory ? String(norm.subcategory).trim() : null,
      type,
      shopPrice,
      shopOldPrice: mmParseNum(norm.shopOldPrice),
      shopStock,
      shopDelivery: mmParseDelivery(norm.shopDelivery),
      shopActive: mmParseActive(norm.shopActive),
      images: mmParseImages(norm.images),
      description: mmComposeDescription(
        norm.description ? String(norm.description).trim() : null,
        {
          model: norm.model ? String(norm.model).trim() : null,
          brand: norm.brand ? String(norm.brand).trim() : null,
          color: norm.color ? String(norm.color).trim() : null,
          size: norm.size ? String(norm.size).trim() : null,
          gender: norm.gender ? String(norm.gender).trim() : null,
        },
      ),
      composition: norm.composition ? String(norm.composition).trim() : null,
      videoUrl: mmParseVideoUrl(norm.videoUrl),
      // Размер — только для экрана проверки (показываем в таблице группы,
      // если заполнен), в базу уходит уже вшитым в description выше —
      // отдельного поля под размер в Product пока нет.
      sizeForPreview: norm.size ? String(norm.size).trim() : null,
    });
  });

  return { accepted, rejected };
}

function mmReadSpreadsheet(file) {
  return new Promise((resolve, reject) => {
    const isExcel = /\.xlsx?$/i.test(file.name);
    if (isExcel) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
          resolve(json);
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      reader.readAsArrayBuffer(file);
    } else {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => resolve(res.data),
        error: (err) => reject(err),
      });
    }
  });
}

let mmUploadAccepted = [];
let mmUploadRejected = [];

async function handleMyMarketFileSelected(file) {
  const progressEl = document.getElementById('mymarketUploadProgress');
  if (!file) return;

  if (!/\.xlsx?$/i.test(file.name)) {
    progressEl.innerHTML = `<p style="color:var(--loss);font-size:12.5px">Нужен файл .xlsx или .xls.</p>`;
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    progressEl.innerHTML = `<p style="color:var(--loss);font-size:12.5px">Файл слишком большой: ${(file.size / 1024 / 1024).toFixed(1)} МБ, максимум 10 МБ.</p>`;
    return;
  }

  progressEl.innerHTML = `<p style="color:var(--text-faint);font-size:12.5px">Читаю файл…</p>`;
  try {
    const rawRows = await mmReadSpreadsheet(file);
    const { accepted, rejected } = mmClassifyRows(rawRows);
    if (!accepted.length && !rejected.length) {
      progressEl.innerHTML = `<p style="color:var(--loss);font-size:12.5px">В файле не нашлось ни одной строки — проверь, что заголовки на первой строке совпадают с шаблоном.</p>`;
      return;
    }
    progressEl.innerHTML = '';
    mmUploadAccepted = accepted;
    mmUploadRejected = rejected;
    renderMmUploadPreview();
  } catch (err) {
    progressEl.innerHTML = `<p style="color:var(--loss);font-size:12.5px">Ошибка чтения файла: ${err.message}</p>`;
  }
}

/** Группирует принятые строки по Категория → Тип, с раскрывающимся
 *  списком товаров внутри каждой группы (артикул/название/цена). */
function renderMmUploadPreview() {
  document.getElementById('mmUploadSteps').hidden = true;
  document.getElementById('mmUploadReport').innerHTML = '';
  const previewEl = document.getElementById('mmUploadPreview');
  previewEl.hidden = false;

  document.getElementById('mmPreviewSummary').innerHTML = `
    <span>Всего строк: <strong>${mmUploadAccepted.length + mmUploadRejected.length}</strong></span>
    <span style="color:var(--accent)">Приняты: <strong>${mmUploadAccepted.length}</strong></span>
    <span style="color:${mmUploadRejected.length ? 'var(--loss)' : 'var(--text-faint)'}">Не приняты: <strong>${mmUploadRejected.length}</strong></span>
  `;

  // Группировка Категория -> Тип -> список товаров.
  const groups = new Map();
  mmUploadAccepted.forEach((row) => {
    const catKey = row.category;
    if (!groups.has(catKey)) groups.set(catKey, new Map());
    const typeMap = groups.get(catKey);
    if (!typeMap.has(row.type)) typeMap.set(row.type, []);
    typeMap.get(row.type).push(row);
  });

  const groupsEl = document.getElementById('mmPreviewGroups');
  if (!groups.size) {
    groupsEl.innerHTML = `<p style="color:var(--text-faint);font-size:12.5px">Нет принятых строк.</p>`;
  } else {
    groupsEl.innerHTML = Array.from(groups.entries()).map(([category, typeMap]) => `
      <div style="margin-bottom:10px">
        <div style="font-weight:600;font-size:13.5px;margin-bottom:4px">${category}</div>
        ${Array.from(typeMap.entries()).map(([type, rows]) => `
          <details style="margin:0 0 6px 14px">
            <summary style="cursor:pointer;font-size:12.5px;color:var(--text-muted)">${type} — ${rows.length} шт.</summary>
            <table class="table" style="margin-top:6px">
              <thead><tr><th>Артикул</th><th>Название</th><th class="num">Цена</th><th>Размер</th></tr></thead>
              <tbody>
                ${rows.map((r) => `<tr><td class="name-cell">${r.sku}</td><td class="name-cell">${r.name}</td><td class="num">${fmtMoney(r.shopPrice)}</td><td>${r.sizeForPreview ?? '—'}</td></tr>`).join('')}
              </tbody>
            </table>
          </details>
        `).join('')}
      </div>
    `).join('');
  }

  const rejectedPanel = document.getElementById('mmPreviewRejectedPanel');
  if (mmUploadRejected.length) {
    rejectedPanel.hidden = false;
    document.getElementById('mmPreviewRejectedBody').innerHTML = mmUploadRejected.map((r) => `
      <tr><td class="name-cell">${r.sku}</td><td class="name-cell">${r.name}</td><td style="color:var(--loss);font-size:12px">${r.reason}</td></tr>
    `).join('');
  } else {
    rejectedPanel.hidden = true;
  }
}

function resetMmUploadScreen() {
  document.getElementById('mmUploadSteps').hidden = false;
  document.getElementById('mmUploadPreview').hidden = true;
  document.getElementById('mymarketUploadFile').value = '';
  document.getElementById('mymarketUploadProgress').innerHTML = '';
  mmUploadAccepted = [];
  mmUploadRejected = [];
}

/** Единственное место, которое реально пишет в базу — по нажатию
 *  «Загрузить принятые». До этого момента ничего не отправлялось на сервер. */
const MM_BULK_UPLOAD_CHUNK_SIZE = 8; // согласовано с сервером (см. .max(20) в shopAdmin.routes.ts — с запасом)
const MM_BULK_UPLOAD_TIMEOUT_MS = 60000;

/**
 * Отправляет одну пачку с таймаутом (AbortController) — если сервер не
 * ответит за 60с, запрос обрывается сам, не виснет бесконечно, и в отчёте
 * будет видно, какая именно пачка не прошла, а не общее "не удалось".
 */
async function postMmBulkUploadChunk(products) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MM_BULK_UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch('/api/shop-admin/bulk-upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products }),
      signal: controller.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* тело не JSON — обработаем через res.ok ниже */ }
    if (!res.ok) {
      const errText = body?.error ?? `HTTP ${res.status}`;
      throw new Error(errText);
    }
    return body;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('таймаут 60 сек — сервер не ответил вовремя');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Единственное место, которое реально пишет в базу — по нажатию
 * «Загрузить принятые». До этого момента ничего не отправлялось на сервер.
 * Пачками по MM_BULK_UPLOAD_CHUNK_SIZE — так каждый отдельный запрос
 * успевает уложиться в ограничение по времени выполнения на Vercel Hobby,
 * даже если строк много. Картинки в этом запросе не передаются вообще —
 * только текстовые поля товара (сами файлы фото загружаются отдельно,
 * через карточку товара, см. /api/shop/admin/upload).
 */
async function confirmMmUpload() {
  const btn = document.getElementById('mmPreviewConfirmBtn');
  if (!mmUploadAccepted.length) { alert('Нет принятых строк для загрузки'); return; }
  btn.disabled = true;

  const chunks = [];
  for (let i = 0; i < mmUploadAccepted.length; i += MM_BULK_UPLOAD_CHUNK_SIZE) {
    chunks.push(mmUploadAccepted.slice(i, i + MM_BULK_UPLOAD_CHUNK_SIZE));
  }

  let created = 0;
  let updated = 0;
  const errors = [];

  for (let i = 0; i < chunks.length; i++) {
    btn.textContent = `Загружаю… пачка ${i + 1} из ${chunks.length}`;
    try {
      const res = await postMmBulkUploadChunk(chunks[i]);
      created += res.created;
      updated += res.updated;
      if (res.errors?.length) errors.push(...res.errors);
    } catch (err) {
      // Одна пачка упала — не бросаем всё, продолжаем со следующей, но
      // честно фиксируем, какая именно и почему.
      errors.push(`Пачка ${i + 1} (${chunks[i].length} тов.): ${err.message}`);
    }
  }

  document.getElementById('mmUploadPreview').hidden = true;
  document.getElementById('mmUploadReport').innerHTML = `
    <div class="panel">
      <p style="color:var(--accent);font-size:13.5px">
        Готово: принято <strong>${created + updated}</strong>
        (создано ${created}, обновлено ${updated}), отклонено <strong>${mmUploadRejected.length}</strong>.
        ${errors.length ? `<br><span style="color:var(--loss)">Ошибок при записи: ${errors.length}<br>${errors.slice(0, 10).map((e) => `— ${e}`).join('<br>')}</span>` : ''}
      </p>
      <button class="btn btn--ghost" id="mmUploadAnotherBtn">Загрузить ещё файл</button>
    </div>
  `;
  document.getElementById('mmUploadAnotherBtn').addEventListener('click', () => {
    resetMmUploadScreen();
    document.getElementById('mmUploadReport').innerHTML = '';
  });
  mmUploadAccepted = [];
  mmUploadRejected = [];
  await loadMyMarketProducts();

  btn.disabled = false;
  btn.textContent = 'Загрузить принятые';
}


async function loadNichesPage() {
  wireNicheFormOnce();
}

// =====================================================================
// ДЕМПИНГ
// =====================================================================
let runRepricerBtnWired = false;
let repricerRuleFormWired = false;

const STRATEGY_LABELS = {
  FIRST_PLACE: 'Быть на 1-м месте',
  MATCH_FIRST: 'Цена конкурента на 1 месте',
  STICK_TO_FIRST: 'Прижиматься к первому',
  SECOND_PLACE: 'Быть 2-м',
};

function wireRepricerRuleFormOnce(kaspiProducts) {
  const select = document.getElementById('repricerProductSelect');
  // Список товаров для выбора обновляем каждый раз (могли добавиться новые),
  // но сам обработчик submit вешаем только один раз.
  const currentValue = select.value;
  select.innerHTML = '<option value="">Выбери товар (с артикулом Kaspi)...</option>' +
    kaspiProducts.map((p) => `<option value="${p.id}">${p.name} (${p.kaspiSku})</option>`).join('');
  if (currentValue) select.value = currentValue;

  if (repricerRuleFormWired) return;
  repricerRuleFormWired = true;

  document.getElementById('repricerRuleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const productId = fd.get('productId');
    if (!productId) { alert('Выбери товар'); return; }

    const payload = {
      kaspiProductUrl: fd.get('kaspiProductUrl'),
      repriceStrategy: fd.get('repriceStrategy'),
      minPrice: Number(fd.get('minPrice')),
      maxPrice: fd.get('maxPrice') ? Number(fd.get('maxPrice')) : null,
      repriceStep: Number(fd.get('repriceStep')) || 1,
      autoRepriceEnabled: fd.get('autoRepriceEnabled') === 'on',
    };

    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = '…'; btn.disabled = true;
    try {
      await api(`/repricer/${productId}/settings`, { method: 'PUT', body: JSON.stringify(payload) });
      e.target.reset();
      await loadDempingPage();
    } catch (err) {
      alert('Не удалось сохранить правило: ' + err.message);
    } finally {
      btn.textContent = 'Добавить правило'; btn.disabled = false;
    }
  });
}

async function loadDempingPage() {
  document.getElementById('priceFeedUrl').textContent = `${window.location.origin}/api/kaspi/price-feed.xml?token=ВАШ_PRICE_FEED_SECRET`;

  if (!runRepricerBtnWired) {
    runRepricerBtnWired = true;
    document.getElementById('runRepricerBtn').addEventListener('click', async () => {
      const btn = document.getElementById('runRepricerBtn');
      btn.textContent = '…'; btn.disabled = true;
      try {
        const res = await api('/repricer/run', { method: 'POST' });
        alert(`Проверено товаров: ${res.results.length}. Изменена цена у: ${res.results.filter((r) => r.changed).length}.`);
        await loadDempingPage();
      } catch (e) {
        alert('Ошибка: ' + e.message);
      } finally {
        btn.textContent = '▶ Применить сейчас'; btn.disabled = false;
      }
    });
  }

  const products = await api('/products');
  const kaspiProducts = products.filter((p) => p.kaspiSku);
  wireRepricerRuleFormOnce(kaspiProducts);

  const total = kaspiProducts.filter((p) => p.kaspiProductUrl).length;
  const active = kaspiProducts.filter((p) => p.autoRepriceEnabled).length;
  const ready = kaspiProducts.filter((p) => p.autoRepriceEnabled && p.kaspiProductUrl && p.minPrice != null).length;

  document.getElementById('dempingStats').innerHTML = kpiCardsHtml([
    { label: 'Всего правил', value: fmt.format(total) },
    { label: 'Активных', value: fmt.format(active), accent: active > 0 },
    { label: 'Готовы применить', value: fmt.format(ready) },
  ]);

  const tbody = document.querySelector('#repricerTable tbody');
  const rulesProducts = kaspiProducts.filter((p) => p.kaspiProductUrl || p.minPrice != null);
  if (!rulesProducts.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-faint)">Правил ещё нет — добавь первое выше</td></tr>`;
    return;
  }

  tbody.innerHTML = rulesProducts.map((p) => `
    <tr data-id="${p.id}">
      <td class="name-cell">${p.name}<br><span style="color:var(--text-faint);font-size:11px">${p.kaspiProductUrl ?? 'ссылка не указана'}</span></td>
      <td>
        <select class="cost-input" style="width:170px" data-field="repriceStrategy">
          ${Object.entries(STRATEGY_LABELS).map(([val, label]) => `<option value="${val}" ${p.repriceStrategy === val ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </td>
      <td class="num"><input class="cost-input" type="number" step="1" placeholder="—" value="${p.minPrice ?? ''}" data-field="minPrice" /></td>
      <td class="num"><input class="cost-input" type="number" step="1" placeholder="—" value="${p.maxPrice ?? ''}" data-field="maxPrice" /></td>
      <td class="num"><input class="cost-input" type="number" step="1" value="${p.repriceStep ?? 1}" data-field="repriceStep" /></td>
      <td class="num">${p.currentKaspiPrice ? fmtMoney(p.currentKaspiPrice) : '—'}</td>
      <td><input type="checkbox" data-field="autoRepriceEnabled" ${p.autoRepriceEnabled ? 'checked' : ''} /></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('input, select').forEach((input) => {
      const evt = (input.type === 'checkbox' || input.tagName === 'SELECT') ? 'change' : 'blur';
      input.addEventListener(evt, async () => {
        const field = input.dataset.field;
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (input.type === 'number') value = value === '' ? null : Number(value);
        await api(`/repricer/${id}/settings`, { method: 'PUT', body: JSON.stringify({ [field]: value }) });
        if (field === 'autoRepriceEnabled') await loadDempingPage();
      });
    });
  });
}

// =====================================================================
// УВЕДОМЛЕНИЯ (журнал синхронизаций как замена нотификациям)
// =====================================================================
let notificationsBtnWired = false;

async function loadNotificationsPage() {
  if (!notificationsBtnWired) {
    notificationsBtnWired = true;
    document.getElementById('refreshNotificationsBtn').addEventListener('click', loadNotificationsPage);
  }

  const logs = await api('/sync/logs');
  const list = document.getElementById('notificationsList');
  if (!logs.length) {
    list.innerHTML = `<p style="color:var(--text-faint);font-size:13px">Событий пока нет — синхронизация ещё не запускалась.</p>`;
    return;
  }

  list.innerHTML = logs.map((log) => {
    const dotClass = log.status === 'SUCCESS' ? 'notif-dot--ok' : log.status === 'ERROR' ? 'notif-dot--err' : 'notif-dot--running';
    const title = `${mpLabel(log.marketplace)}: ${log.status}` + (log.ordersProcessed ? ` — обработано заказов: ${log.ordersProcessed}` : '');
    const meta = `${new Date(log.startedAt).toLocaleString('ru-RU')}${log.message ? ' · ' + log.message : ''}`;
    return `
      <div class="notif-item">
        <span class="notif-dot ${dotClass}"></span>
        <div>
          <div class="notif-title">${title}</div>
          <div class="notif-meta">${meta}</div>
        </div>
      </div>
    `;
  }).join('');
}

// =====================================================================
// НАСТРОЙКИ
// =====================================================================
let kaspiStoreFormWired = false;

function wireKaspiStoreFormOnce() {
  if (kaspiStoreFormWired) return;
  kaspiStoreFormWired = true;

  document.getElementById('kaspiStoreForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      name: fd.get('name'),
      bin: fd.get('bin') || null,
      contactPhone: fd.get('contactPhone') || null,
      contactEmail: fd.get('contactEmail') || null,
      apiToken: fd.get('apiToken'),
      merchantUid: fd.get('merchantUid') || null,
    };
    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = '…'; btn.disabled = true;
    try {
      await api('/settings/kaspi-store', { method: 'POST', body: JSON.stringify(payload) });
      alert('Магазин сохранён. Все запросы к Kaspi теперь используют этот токен.');
      e.target.reset();
      await loadKaspiStoreCurrent();
      await refreshSyncStatusMini();
    } catch (err) {
      alert('Не удалось сохранить магазин: ' + err.message);
    } finally {
      btn.textContent = 'Сохранить магазин'; btn.disabled = false;
    }
  });
}

async function loadKaspiStoreCurrent() {
  const store = await api('/settings/kaspi-store');
  const el = document.getElementById('kaspiStoreCurrent');
  if (!store) {
    el.textContent = 'Магазин ещё не добавлен — заполни форму ниже.';
    return;
  }
  el.innerHTML = `Текущий магазин: <strong style="color:var(--text)">${store.name}</strong>` +
    (store.bin ? ` · БИН ${store.bin}` : '') +
    ` · токен: <code>${store.apiTokenMasked}</code>`;
}

let ozonStoreFormWired = false;

function wireOzonStoreFormOnce() {
  if (ozonStoreFormWired) return;
  ozonStoreFormWired = true;

  document.getElementById('ozonStoreForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      clientId: fd.get('clientId'),
      apiKey: fd.get('apiKey'),
    };
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    try {
      await api('/settings/ozon-store', { method: 'POST', body: JSON.stringify(payload) });
      alert('Магазин Ozon сохранён. Все запросы к Ozon теперь используют этот Client-Id/Api-Key.');
      e.target.reset();
      await loadOzonStoreCurrent();
      await refreshSyncStatusMini();
    } catch (err) {
      alert('Не удалось сохранить магазин Ozon: ' + err.message);
    } finally {
      btn.textContent = originalText; btn.disabled = false;
    }
  });
}

async function loadOzonStoreCurrent() {
  const store = await api('/settings/ozon-store');
  const el = document.getElementById('ozonStoreCurrent');
  if (!store) {
    el.textContent = 'Магазин ещё не добавлен — заполни форму ниже.';
    return;
  }
  el.innerHTML = `Client-Id: <strong style="color:var(--text)">${store.clientId}</strong> · Api-Key: <code>${store.apiKeyMasked}</code>`;
}

let wbStoreFormWired = false;

function wireWbStoreFormOnce() {
  if (wbStoreFormWired) return;
  wbStoreFormWired = true;

  document.getElementById('wbStoreForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { apiToken: fd.get('apiToken') };
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    try {
      await api('/settings/wb-store', { method: 'POST', body: JSON.stringify(payload) });
      alert('Магазин Wildberries сохранён. Все запросы к WB теперь используют этот токен.');
      e.target.reset();
      await loadWbStoreCurrent();
      await refreshSyncStatusMini();
    } catch (err) {
      alert('Не удалось сохранить магазин WB: ' + err.message);
    } finally {
      btn.textContent = originalText; btn.disabled = false;
    }
  });
}

async function loadWbStoreCurrent() {
  const store = await api('/settings/wb-store');
  const el = document.getElementById('wbStoreCurrent');
  if (!store) {
    el.textContent = 'Магазин ещё не добавлен — заполни форму ниже.';
    return;
  }
  el.innerHTML = `Токен: <code>${store.apiTokenMasked}</code>`;
}

let taxSettingsFormWired = false;

function wireTaxSettingsFormOnce() {
  if (taxSettingsFormWired) return;
  taxSettingsFormWired = true;

  document.getElementById('taxSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    try {
      await api('/settings/tax', { method: 'POST', body: JSON.stringify({ ratePct: Number(fd.get('ratePct')) }) });
      alert('Ставка налога сохранена. Применится сразу на «Финансы», «Обзоре» и в таблице «Товары».');
    } catch (err) {
      alert('Не удалось сохранить ставку налога: ' + err.message);
    } finally {
      btn.textContent = originalText; btn.disabled = false;
    }
  });
}

async function loadTaxSettings() {
  const settings = await api('/settings/tax');
  document.querySelector('#taxSettingsForm input[name="ratePct"]').value = settings.ratePct;
}

async function loadSettingsPage() {
  wireKaspiStoreFormOnce();
  wireOzonStoreFormOnce();
  wireWbStoreFormOnce();
  wireTaxSettingsFormOnce();
  await loadKaspiStoreCurrent();
  await loadOzonStoreCurrent();
  await loadWbStoreCurrent();
  await loadTaxSettings();

  const status = await api('/sync/status');

  document.querySelector('#connectionsTable tbody').innerHTML = `
    <tr><td><span class="mp-tag"><i class="dot dot--kaspi"></i>Kaspi</span></td><td>${status.kaspi.configured ? '✅ Подключён' : '⚪ Не настроен'}</td></tr>
    <tr><td><span class="mp-tag"><i class="dot dot--ozon"></i>Ozon</span></td><td>${status.ozon.configured ? '✅ Подключён' : '⚪ Не настроен'}</td></tr>
    <tr><td><span class="mp-tag"><i class="dot dot--wb"></i>WB</span></td><td>${status.wb.configured ? '✅ Подключён' : '⚪ Не настроен'}</td></tr>
  `;

  document.getElementById('settingsPriceFeedUrl').textContent = `${window.location.origin}/api/kaspi/price-feed.xml?token=ВАШ_PRICE_FEED_SECRET`;
  document.getElementById('settingsCronInfo').textContent =
    `Встроенный (Vercel) запуск: ${status.cron}. Для более частого запуска настройте внешний планировщик (cron-job.org) — см. README.`;
}

// =====================================================================
// Общие фильтры (дата / площадка / синхронизация) — наверху, действуют
// на текущую открытую страницу.
// =====================================================================
function reloadCurrentPage() {
  return PAGE_LOADERS[state.currentPage]?.();
}

document.getElementById('mpFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('.mp-filter__btn');
  if (!btn) return;
  document.querySelectorAll('.mp-filter__btn').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  state.marketplace = btn.dataset.mp;
  productsCurrentPage = 1;
  // Выбор товаров чекбоксами — тоже сбрасываем: иначе счётчик "Выбрано"
  // показывал бы товары с ДРУГОЙ площадки, отмеченные до переключения.
  selectedProductIds.clear();
  reloadCurrentPage();
});

document.querySelectorAll('.preset-group button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-group button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const days = Number(btn.dataset.days);
    const toStr = todayISO();
    const fromStr = almatyDateDaysAgo(days);
    document.getElementById('dateTo').value = toStr;
    document.getElementById('dateFrom').value = fromStr;
    state.from = fromStr;
    state.to = toStr;
    reloadCurrentPage();
  });
});

/**
 * Автообновление периода «Сегодня» после полуночи (по Алматы) — без этого
 * пользователь, оставивший вкладку открытой на ночь, продолжал бы видеть
 * вчерашний день как «сегодня», пока сам не обновит страницу. Проверяем
 * раз в минуту: если активна кнопка «Сегодня» (data-days="0") и
 * календарная дата по Алматы уже сменилась — пересчитываем диапазон и
 * перезагружаем текущую страницу.
 */
setInterval(() => {
  const activeBtn = document.querySelector('.preset-group button.is-active');
  if (!activeBtn || activeBtn.dataset.days !== '0') return;
  const freshToday = todayISO();
  if (freshToday !== state.to) {
    document.getElementById('dateTo').value = freshToday;
    document.getElementById('dateFrom').value = freshToday;
    state.from = freshToday;
    state.to = freshToday;
    reloadCurrentPage();
  }
}, 60 * 1000);

['dateFrom', 'dateTo'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    state.from = document.getElementById('dateFrom').value;
    state.to = document.getElementById('dateTo').value;
    // Ручной ввод даты — это осознанный выбор пользователя, отличный от
    // пресетов. Снимаем подсветку "активного" пресета (включая «Сегодня»),
    // иначе автообновление в полночь могло бы неожиданно перезаписать то,
    // что человек только что ввёл вручную.
    document.querySelectorAll('.preset-group button').forEach((b) => b.classList.remove('is-active'));
    reloadCurrentPage();
  });
});

document.getElementById('groupBySeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#groupBySeg button').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  state.groupBy = btn.dataset.group;
  loadTrend();
});

async function refreshSyncStatusMini() {
  const status = await api('/sync/status');
  const el = document.getElementById('syncStatusMini');
  const parts = [];
  if (status.kaspi.configured) parts.push('Kaspi ✓');
  if (status.ozon.configured) parts.push('Ozon ✓');
  if (status.wb.configured) parts.push('WB ✓');
  el.textContent = parts.length ? parts.join(' · ') : 'Площадки не настроены';
}

document.getElementById('syncKaspiBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncKaspiBtn');
  const days = Number(document.getElementById('kaspiSyncDays').value) || 7;
  btn.textContent = '…'; btn.disabled = true;
  try {
    const res = await runChunkedKaspiSync(days);
    // Сама синхронизация уже прошла успешно к этому моменту — данные
    // сохранены в базе. Ошибку перерисовки страницы (например, график ещё
    // не успел загрузиться) НЕ считаем ошибкой синхронизации — иначе
    // пользователь увидит пугающее "ошибка синхронизации" по товару,
    // который на самом деле уже сохранился.
    try {
      await reloadCurrentPage();
    } catch (renderErr) {
      console.warn('Синхронизация Kaspi прошла успешно, но при обновлении страницы возникла ошибка:', renderErr);
    }
    alert(`Синхронизировано заказов: ${res.ordersProcessed}. Создано товаров: ${res.productsCreated}.`);
  } catch (err) {
    alert('Ошибка синхронизации Kaspi: ' + err.message);
  } finally {
    btn.textContent = '↻ Kaspi'; btn.disabled = false;
  }
});

document.getElementById('syncOzonBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncOzonBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const res = await api('/sync/ozon?days=7', { method: 'POST' });
    try {
      await reloadCurrentPage();
    } catch (renderErr) {
      console.warn('Синхронизация Ozon прошла успешно, но при обновлении страницы возникла ошибка:', renderErr);
    }
    alert(`Синхронизация Ozon завершена. Обработано заказов: ${res.ordersProcessed ?? 0}.`);
  } catch (err) {
    alert('Ошибка синхронизации Ozon: ' + err.message);
  } finally {
    btn.textContent = '↻ Ozon'; btn.disabled = false;
  }
});

document.getElementById('syncWbBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncWbBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    // ВАЖНО: раньше эта кнопка запускала ЕЩЁ и синхронизацию каталога сразу
    // следом — из-за этого общее время могло превышать лимит serverless-
    // функции (таймаут >55с), и каталог с ценами/комиссией даже не успевал
    // запуститься. Теперь кнопка делает только заказы — каталог (цены,
    // комиссия по справочнику WB) синхронизируется отдельно кнопкой
    // «Каталог WB» на странице «Товары», без риска общего таймаута.
    const ordersRes = await api('/sync/wb?days=7', { method: 'POST' });
    try {
      await reloadCurrentPage();
    } catch (renderErr) {
      console.warn('Синхронизация WB прошла успешно, но при обновлении страницы возникла ошибка:', renderErr);
    }
    alert(`Синхронизация заказов WB завершена. Обработано заказов: ${ordersRes.ordersProcessed ?? 0}.\nДля цен и комиссии по каталогу используй кнопку «Каталог WB» на странице «Товары».`);
  } catch (err) {
    alert('Ошибка синхронизации WB: ' + err.message);
  } finally {
    btn.textContent = '↻ WB'; btn.disabled = false;
  }
});

// =====================================================================
// Инициализация
// =====================================================================
(async function init() {
  initDateRange();
  refreshSyncStatusMini();

  const startPage = (window.location.hash || '').replace('#', '') || 'overview';
  showPage(PAGE_LOADERS[startPage] ? startPage : 'overview');
})();
