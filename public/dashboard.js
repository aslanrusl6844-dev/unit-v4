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
let kaspiRatesCache = null; // { "Категория": 10.9, ... } — для валидации файла при массовой загрузке
let productsForecastCache = new Map(); // "productId:MARKETPLACE" -> прогноз "если продать по текущей цене сейчас" (см. getProductForecasts)
let selectedProductIds = new Set(); // выбранные чекбоксами товары — сохраняется между страницами пагинации, сбрасывается при смене фильтра/площадки
let productsCurrentPage = 1;
const PRODUCTS_PAGE_SIZE = 15;

async function loadKaspiCategoriesIntoSelect(selectEl) {
  const categories = await api('/products/kaspi-categories');
  if (!kaspiRatesCache) {
    kaspiRatesCache = {};
    categories.forEach((c) => { kaspiRatesCache[c.name] = c.rate; });
  }
  if (!selectEl || selectEl.dataset.loaded) return;
  categories
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = `${c.name} (${c.rate}%)`;
      selectEl.appendChild(opt);
    });
  selectEl.dataset.loaded = '1';
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
      alert(`Каталог WB синхронизирован. Создано товаров: ${res.created}. Обновлено: ${res.updated}.`);
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
async function handleBulkUpload() {
  const fileInput = document.getElementById('bulkUploadFile');
  const file = fileInput.files[0];
  const progressEl = document.getElementById('bulkUploadProgress');
  const btn = document.getElementById('bulkUploadBtn');

  if (!file) { alert('Сначала выбери файл'); return; }

  progressEl.innerHTML = `<p style="color:var(--text-faint);font-size:12.5px">Читаю файл…</p>`;
  btn.disabled = true;

  try {
    const rows = await parseSpreadsheetFile(file);
    if (!rows.length) {
      progressEl.innerHTML = `<p style="color:var(--loss);font-size:12.5px">Не удалось найти ни одной строки с обязательными колонками sku/name.</p>`;
      return;
    }

    const CHUNK = 150;
    let created = 0, updated = 0;
    const allErrors = [];

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      progressEl.innerHTML = `<p style="color:var(--text-muted);font-size:12.5px">Загружено ${i} из ${rows.length}…</p>`;
      const res = await api('/products/bulk-upsert', { method: 'POST', body: JSON.stringify({ products: chunk }) });
      created += res.created;
      updated += res.updated;
      allErrors.push(...res.errors);
    }

    progressEl.innerHTML = `
      <p style="color:var(--accent);font-size:12.5px">
        Готово: создано ${created}, обновлено ${updated} из ${rows.length}.
        ${allErrors.length ? `Ошибок: ${allErrors.length} (первые: ${allErrors.slice(0, 5).join('; ')})` : ''}
      </p>`;
    fileInput.value = '';
    await loadProductsAdminTable();
  } catch (err) {
    progressEl.innerHTML = `<p style="color:var(--loss);font-size:12.5px">Ошибка: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
  }
}

/** Разбирает CSV (PapaParse) или Excel (SheetJS) в массив строк для bulk-upsert. */
function parseSpreadsheetFile(file) {
  return new Promise((resolve, reject) => {
    const isExcel = /\.xlsx?$/i.test(file.name);

    const normalizeRow = (row) => {
      // Ключи колонок могут быть с разным регистром/пробелами — приводим к единому виду.
      const norm = {};
      Object.keys(row).forEach((k) => { norm[k.trim().toLowerCase()] = row[k]; });
      const sku = String(norm.sku ?? '').trim();
      const name = String(norm.name ?? norm['название'] ?? '').trim();
      if (!sku || !name) return null;
      return {
        sku,
        name,
        kaspiSku: norm.kaspisku ? String(norm.kaspisku).trim() : null,
        costPrice: Number(norm.costprice ?? norm['себестоимость'] ?? 0) || 0,
        kaspiTopCategory: norm.kaspitopcategory ? String(norm.kaspitopcategory).trim() : null,
      };
    };

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          resolve(json.map(normalizeRow).filter(Boolean));
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      reader.readAsArrayBuffer(file);
    } else {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => resolve(res.data.map(normalizeRow).filter(Boolean)),
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
  if (!isLinkedToMarketplace(p, marketplace)) {
    // Товар вообще не привязан к этой площадке (нет артикула) — редактировать нечего.
    return `<td class="num" style="border-left:2px solid var(--border);color:var(--text-faint)">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>`;
  }
  const fc = productsForecastCache.get(`${p.id}:${marketplace}`);
  const badge = (fc?.source === 'historical-average' || fc?.source === 'kaspi-tariff-default')
    ? ` <span style="color:var(--text-faint);font-size:10px" title="${fc.source === 'kaspi-tariff-default' ? 'Категория неизвестна — применена усреднённая ставка комиссии Kaspi (12.5%), укажи категорию для точного расчёта' : `Оценка по средней ставке из прошлых продаж этого товара на ${mpLabel(marketplace)}`}">≈</span>`
    : '';
  const priceValue = fc?.referencePrice != null ? fc.referencePrice : '';
  return `
    <td class="num" style="border-left:2px solid var(--border)">
      <input class="cost-input" type="number" step="1" placeholder="Цена" value="${priceValue}" data-price-field="${priceFieldName(marketplace)}" style="width:85px" />
    </td>
    <td class="num">${fc?.estCommission != null ? `${fmtMoney(fc.estCommission)}${fc.estCommissionRate != null ? ` <span style="color:var(--text-faint);font-size:10px">(${fc.estCommissionRate}%)</span>` : ''}` + badge : '—'}</td>
    <td class="num">${fc?.estLogistics != null ? fmtMoney(fc.estLogistics) + badge : '—'}</td>
    <td class="num">${fc?.estTax != null ? fmtMoney(fc.estTax) : '—'}</td>
    <td class="num ${fc?.estPayout != null ? (fc.estPayout >= 0 ? 'pos' : 'neg') : ''}" title="С учётом налога ИП">${fc?.estPayout != null ? fmtMoney(fc.estPayout) : '—'}</td>
    <td class="num ${fc?.estMarginAfterTaxPct != null ? (fc.estMarginAfterTaxPct >= 0 ? 'pos' : 'neg') : ''}" title="С учётом налога ИП">${fc?.estMarginAfterTaxPct != null ? fmtPct(fc.estMarginAfterTaxPct) : '—'}</td>
  `;
}

/** Выпадающий список категории Kaspi прямо в строке таблицы. Если точной
 *  верхней категории нет, но Kaspi прислал leaf-категорию (например,
 *  "Зонты") — показываем её как есть, это уже реальные данные, а не
 *  "нет категории". Предупреждение — только когда неизвестно вообще всё. */
function categorySelectHtml(topCategory, leafCategory) {
  const options = kaspiRatesCache
    ? Object.keys(kaspiRatesCache).sort((a, b) => a.localeCompare(b, 'ru')).map((name) => `<option value="${name}" ${name === topCategory ? 'selected' : ''}>${name} (${kaspiRatesCache[name]}%)</option>`).join('')
    : '';
  let placeholderText;
  let borderColor;
  if (topCategory) {
    placeholderText = '';
    borderColor = '';
  } else if (leafCategory) {
    // Реальная категория от Kaspi есть, просто не сопоставлена с нашей
    // верхнеуровневой таблицей ставок — комиссия всё равно уже считается
    // (по leaf-исключению или безопасному дефолту, см. ≈ у цифр).
    placeholderText = `<option value="" selected>${leafCategory}</option>`;
    borderColor = 'border-color:var(--text-faint)';
  } else {
    placeholderText = `<option value="" selected>⚠ нет категории</option>`;
    borderColor = 'border-color:var(--warn)';
  }
  return `<select class="cost-input" data-field="kaspiTopCategory" style="font-size:11px;margin-top:4px;${borderColor}" title="${leafCategory ? `Категория от Kaspi: ${leafCategory}. ` : ''}Выбери верхнюю категорию для точного тарифа комиссии">${placeholderText}${options}</select>`;
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
  if (marketplaces.length === 1) {
    // Одна площадка — шапка в один ряд, широкие понятные колонки, без group-заголовков.
    const mp = marketplaces[0];
    thead.innerHTML = `
      <tr>
        ${selectAllCb}
        <th>SKU</th><th>Название</th><th>Артикул ${mpLabel(mp)}</th>
        <th class="num">Себестоимость</th>
        <th class="num">Цена</th>
        <th class="num">Комиссия</th>
        <th class="num">Логистика</th>
        <th class="num">Налог</th>
        <th class="num" title="С учётом налога ИП">Прибыль/шт</th>
        <th class="num" title="С учётом налога ИП">Маржа</th>
        <th>Активен</th><th></th>
      </tr>
    `;
  } else {
    // "Всё вместе" — три компактных блока, как раньше (без единственно
    // очевидного выбора площадки это разумный компромисс).
    const groupHeaders = marketplaces.map((mp) => `<th colspan="6" style="text-align:center;border-left:2px solid var(--border)"><span class="dot dot--${mp.toLowerCase()}"></span> ${mpLabel(mp)}</th>`).join('');
    const subHeaders = marketplaces.map(() => `
      <th class="num" style="border-left:2px solid var(--border)">Цена</th>
      <th class="num">Комиссия</th><th class="num">Логистика</th><th class="num">Налог</th>
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
  const totalCols = 5 + marketplaces.length * 6 + 2; // +1 за колонку чекбокса, 6 колонок на площадку (цена/комиссия/логистика/налог/прибыль/маржа)

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
      articlesCell = `${value ?? '—'}${mp === 'KASPI' ? categorySelectHtml(p.kaspiTopCategory, p.kaspiLeafCategory) : ''}`;
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
  // Категория Kaspi — редактируется прямо в таблице.
  tbody.querySelectorAll('select[data-field="kaspiTopCategory"]').forEach((select) => {
    select.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      try {
        await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ kaspiTopCategory: e.target.value || null }) });
        await loadProductsAdminTable();
      } catch (err) {
        alert('Не удалось сохранить категорию: ' + err.message);
      }
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

['dateFrom', 'dateTo'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    state.from = document.getElementById('dateFrom').value;
    state.to = document.getElementById('dateTo').value;
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
    // Заказы и каталог у WB — это ДВА разных источника данных (Statistics
    // API и Content API), поэтому один запрос не может дать оба сразу.
    // Раньше эта кнопка тянула только заказы, а каталог нужно было
    // синхронизировать отдельно на странице «Товары» — легко не заметить.
    // Теперь одна кнопка запускает оба действия по очереди.
    const ordersRes = await api('/sync/wb?days=7', { method: 'POST' });

    let catalogMsg = '';
    try {
      const catalogRes = await api('/sync/wb-catalog', { method: 'POST' });
      catalogMsg = ` Каталог: создано ${catalogRes.created}, обновлено ${catalogRes.updated}.`;
    } catch (catalogErr) {
      // Заказы могли синхронизироваться успешно, даже если с каталогом
      // что-то не так (например, токен создан без категории доступа
      // "Контент") — не превращаем это в общую "ошибку синхронизации".
      catalogMsg = ` Каталог не удалось обновить: ${catalogErr.message}`;
    }

    try {
      await reloadCurrentPage();
    } catch (renderErr) {
      console.warn('Синхронизация WB прошла успешно, но при обновлении страницы возникла ошибка:', renderErr);
    }
    alert(`Синхронизация WB завершена. Обработано заказов: ${ordersRes.ordersProcessed ?? 0}.${catalogMsg}`);
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
