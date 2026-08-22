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

function todayISO(d = new Date()) { return d.toISOString().slice(0, 10); }

function initDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  document.getElementById('dateTo').value = todayISO(to);
  document.getElementById('dateFrom').value = todayISO(from);
  state.from = todayISO(from);
  state.to = todayISO(to);
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
  niches: () => {}, // статичная заглушка, грузить нечего
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

  // Крупная карточка чистой прибыли — обновляется вместе с воронкой,
  // из тех же данных сводки (summary.netProfit), так что расхождений
  // между ними быть не может.
  const cardValueEl = document.getElementById('netProfitCardValue');
  if (cardValueEl) {
    const netProfit = summary.netProfit || 0;
    cardValueEl.textContent = fmtMoney(netProfit);
    cardValueEl.style.color = netProfit >= 0 ? 'var(--accent)' : 'var(--loss)';
    const card = document.getElementById('netProfitCard');
    card.style.background = netProfit >= 0
      ? 'linear-gradient(160deg, var(--accent-soft), var(--surface))'
      : 'linear-gradient(160deg, var(--loss-soft), var(--surface))';
    card.style.borderColor = netProfit >= 0 ? 'rgba(22,163,74,0.35)' : 'rgba(220,38,38,0.35)';
  }

  const revenue = summary.revenue || 0;
  const cogs = summary.cogs || 0;
  const fees = (summary.marketplaceCommission || 0) + (summary.logisticsCost || 0) + (summary.acquiringCost || 0) + (summary.otherFees || 0);
  const ads = (summary.adSpend || 0) + (summary.manualExpenses || 0);
  const net = summary.netProfit || 0;

  const total = Math.max(revenue, 1);
  const seg = (val) => Math.max((Math.abs(val) / total) * 100, val === 0 ? 0 : 1.2);

  el.innerHTML = `
    <div class="wf-row">
      <div class="wf-seg wf-seg--revenue" style="flex: ${seg(revenue)}"></div>
      <div class="wf-seg wf-seg--cost" style="flex: ${seg(cogs)}"></div>
      <div class="wf-seg wf-seg--cost" style="flex: ${seg(fees)}"></div>
      <div class="wf-seg wf-seg--cost" style="flex: ${seg(ads)}"></div>
      <div class="wf-seg wf-seg--profit" style="flex: ${seg(Math.max(net,0))}"></div>
    </div>
    <div class="wf-labels">
      <span>Выручка ${fmtMoney(revenue)}</span>
      <span>Чистая прибыль ${fmtMoney(net)}</span>
    </div>
    <div class="wf-legend">
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--bg);border:1px solid var(--border)"></span>Выручка</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--loss)"></span>Себестоимость ${fmtMoney(cogs)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--loss)"></span>Комиссии/логистика ${fmtMoney(fees)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--loss)"></span>Реклама и прочее ${fmtMoney(ads)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--accent)"></span>Чистая прибыль</div>
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
    { label: 'Прибыль', value: fmtMoney(summary.netProfit), cls: summary.netProfit >= 0 ? 'pos' : 'neg', accent: true },
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
      <td>${new Date(o.orderDate).toLocaleDateString('ru-RU')}</td>
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
let productsEconomicsCache = new Map(); // sku -> {quantity, revenue, commission, logistics, profit, marginPct} за текущий период

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
    renderProductsAdminTable();
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
      await loadProductsAdminTable();
    } catch (err) {
      alert('Ошибка синхронизации: ' + err.message);
    } finally {
      btn.textContent = '↻ Синхронизировать каталог'; btn.disabled = false;
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
  const [products, economics] = await Promise.all([
    api('/products'),
    api(`/analytics/by-product?${qs({ from: state.from, to: state.to, marketplace: state.marketplace })}`),
  ]);
  allProductsCache = products;
  productsEconomicsCache = new Map(economics.map((e) => [e.sku, e]));
  renderProductsAdminTable();
}

function renderProductsAdminTable() {
  const filter = document.querySelector('#productStatusTabs button.is-active')?.dataset.filter || 'active';
  let products = allProductsCache;
  if (filter === 'active') products = products.filter((p) => p.active !== false);
  if (filter === 'inactive') products = products.filter((p) => p.active === false);

  const tbody = document.querySelector('#productsAdminTable tbody');
  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="12" style="color:var(--text-faint)">Товаров в этой категории нет</td></tr>`;
    return;
  }
  tbody.innerHTML = products.map((p) => {
    const ue = productsEconomicsCache.get(p.sku);
    // Есть продажи, но не указана категория Kaspi -> комиссия всегда 0,
    // прибыль в таком случае завышена. Явно предупреждаем, а не молчим.
    const missingCategory = ue && ue.quantity > 0 && !p.kaspiTopCategory;
    const categoryCell = p.kaspiTopCategory
      ? `<br><span style="color:var(--text-faint);font-size:11px">${p.kaspiLeafCategory ?? p.kaspiTopCategory}</span>`
      : missingCategory
        ? `<br><span style="color:var(--warn);font-size:11px" title="Без категории комиссия считается как 0 — прибыль по этому товару завышена">⚠ нет категории</span>`
        : '';
    return `
    <tr data-id="${p.id}">
      <td class="name-cell">${p.sku}</td>
      <td class="name-cell">${p.name}</td>
      <td class="name-cell">${p.kaspiSku ?? '—'}${categoryCell}</td>
      <td class="num"><input class="cost-input" type="number" step="0.01" value="${p.costPrice}" data-field="costPrice" /></td>
      <td class="num">${ue ? fmt.format(ue.quantity) : '—'}</td>
      <td class="num">${ue ? fmtMoney(ue.revenue) : '—'}</td>
      <td class="num">${ue ? fmtMoney(ue.commission) : '—'}</td>
      <td class="num">${ue ? fmtMoney(ue.logistics) : '—'}</td>
      <td class="num ${ue ? (ue.profit >= 0 ? 'pos' : 'neg') : ''}">${ue ? fmtMoney(ue.profit) : '—'}</td>
      <td class="num ${ue ? (ue.marginPct >= 0 ? 'pos' : 'neg') : ''}">${ue ? fmtPct(ue.marginPct) : '—'}</td>
      <td><input type="checkbox" data-field="active" ${p.active !== false ? 'checked' : ''} /></td>
      <td><button class="link-btn" data-action="delete">✕</button></td>
    </tr>
  `;
  }).join('');

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
    tbody.innerHTML = `<tr><td colspan="10" style="color:var(--text-faint)">Нет данных за период</td></tr>`;
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
      <td class="num">${fmtMoney(p.commission)}</td>
      <td class="num">${fmtMoney(p.logistics)}</td>
      <td class="num">${fmtMoney(p.adSpend)}</td>
      <td class="num ${p.netProfit >= 0 ? 'pos' : 'neg'}">${fmtMoney(p.netProfit)}</td>
      <td class="num ${p.marginPct >= 0 ? 'pos' : 'neg'}">${fmtPct(p.marginPct)}</td>
    </tr>
  `).join('');

  // Строка "Итого" — суммы по всем денежным колонкам. Средняя цена и маржа
  // считаются заново от суммарных чисел (не среднее из строк — так корректнее).
  const totals = data.reduce((acc, p) => ({
    quantity: acc.quantity + p.quantity,
    revenue: acc.revenue + p.revenue,
    cogs: acc.cogs + p.cogs,
    commission: acc.commission + p.commission,
    logistics: acc.logistics + p.logistics,
    adSpend: acc.adSpend + p.adSpend,
    netProfit: acc.netProfit + p.netProfit,
  }), { quantity: 0, revenue: 0, cogs: 0, commission: 0, logistics: 0, adSpend: 0, netProfit: 0 });
  const totalMarginPct = totals.revenue > 0 ? (totals.netProfit / totals.revenue) * 100 : 0;
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

async function loadSettingsPage() {
  wireKaspiStoreFormOnce();
  wireOzonStoreFormOnce();
  await loadKaspiStoreCurrent();
  await loadOzonStoreCurrent();

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
  reloadCurrentPage();
});

document.querySelectorAll('.preset-group button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-group button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const days = Number(btn.dataset.days);
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    document.getElementById('dateTo').value = todayISO(to);
    document.getElementById('dateFrom').value = todayISO(from);
    state.from = todayISO(from);
    state.to = todayISO(to);
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
    await reloadCurrentPage();
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
    await reloadCurrentPage();
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
    const res = await api('/sync/wb?days=7', { method: 'POST' });
    await reloadCurrentPage();
    alert(`Синхронизация WB завершена. Обработано заказов: ${res.ordersProcessed ?? 0}.`);
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
