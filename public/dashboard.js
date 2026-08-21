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
    { label: 'Выручка', value: fmtMoney(summary.revenue), accent: true },
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
  const data = await api(`/analytics/by-product?${qs({ from: state.from, to: state.to, marketplace: state.marketplace })}`);
  const tbody = document.querySelector('#popularProductsTable tbody');
  const top = data.slice(0, 8);
  if (!top.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--text-faint)">Продаж пока нет</td></tr>`;
    return;
  }
  tbody.innerHTML = top.map((p) => `
    <tr>
      <td class="name-cell">${p.name}</td>
      <td class="num">${fmt.format(p.quantity)}</td>
      <td class="num">${fmtMoney(p.revenue)}</td>
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
    loadOrders();
  });
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
  if (!res.orders.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-faint)">Нет заказов за период</td></tr>`;
    return;
  }
  tbody.innerHTML = res.orders.map((o) => `
    <tr>
      <td>${o.externalId}</td>
      <td><span class="mp-tag"><i class="dot dot--${o.marketplace.toLowerCase()}"></i>${mpLabel(o.marketplace)}</span></td>
      <td>${new Date(o.orderDate).toLocaleDateString('ru-RU')}</td>
      <td>${o.status}</td>
      <td class="num">${fmtMoney(o.totalRevenue)}</td>
      <td>${orderActionCell(o)}</td>
    </tr>
  `).join('');

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

async function loadKaspiCategoriesIntoSelect(selectEl) {
  if (!selectEl || selectEl.dataset.loaded) return;
  const categories = await api('/products/kaspi-categories');
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
}

async function loadProductsPage() {
  wireProductsFormOnce();
  await loadKaspiCategoriesIntoSelect(document.getElementById('kaspiTopCategorySelect'));
  await loadProductsAdminTable();
}

async function loadProductsAdminTable() {
  allProductsCache = await api('/products');
  renderProductsAdminTable();
}

function renderProductsAdminTable() {
  const filter = document.querySelector('#productStatusTabs button.is-active')?.dataset.filter || 'active';
  let products = allProductsCache;
  if (filter === 'active') products = products.filter((p) => p.active !== false);
  if (filter === 'inactive') products = products.filter((p) => p.active === false);

  const tbody = document.querySelector('#productsAdminTable tbody');
  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--text-faint)">Товаров в этой категории нет</td></tr>`;
    return;
  }
  tbody.innerHTML = products.map((p) => `
    <tr data-id="${p.id}">
      <td class="name-cell">${p.sku}</td>
      <td class="name-cell">${p.name}</td>
      <td class="name-cell">${p.kaspiSku ?? '—'}${p.kaspiTopCategory ? `<br><span style="color:var(--text-faint);font-size:11px">${p.kaspiLeafCategory ?? p.kaspiTopCategory}</span>` : ''}</td>
      <td>${p.ozonOfferId ?? '—'}</td>
      <td>${p.wbArticle ?? '—'}</td>
      <td class="num"><input class="cost-input" type="number" step="0.01" value="${p.costPrice}" data-field="costPrice" /></td>
      <td><input type="checkbox" data-field="active" ${p.active !== false ? 'checked' : ''} /></td>
      <td><button class="link-btn" data-action="delete">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('input[data-field="costPrice"]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ costPrice: Number(e.target.value) }) });
      await loadProductsAdminTable();
    });
  });
  tbody.querySelectorAll('input[data-field="active"]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ active: e.target.checked }) });
      await loadProductsAdminTable();
    });
  });
  tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      if (!confirm('Удалить товар?')) return;
      await api(`/products/${id}`, { method: 'DELETE' });
      await loadProductsAdminTable();
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
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-faint)">Нет данных за период</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((p) => `
    <tr>
      <td class="name-cell">${p.name}</td>
      <td class="num">${fmt.format(p.quantity)}</td>
      <td class="num">${fmtMoney(p.revenue)}</td>
      <td class="num">${fmtMoney(p.cogs)}</td>
      <td class="num">${fmtMoney(p.profit)}</td>
      <td class="num">${fmtPct(p.marginPct)}</td>
    </tr>
  `).join('');
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

function wireMarginFormOnce() {
  if (marginFormWired) return;
  marginFormWired = true;

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
      btn.textContent = 'Проверить'; btn.disabled = false;
    }
  });

  document.getElementById('marginCalcForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      price: Number(fd.get('price')),
      costPrice: Number(fd.get('costPrice')),
      packagingCost: Number(fd.get('packagingCost')) || 0,
      weightKg: Number(fd.get('weightKg')) || 0.5,
      kaspiTopCategory: fd.get('kaspiTopCategory'),
      deliveryZone: fd.get('deliveryZone'),
    };
    const result = await api('/margin-calculator/calculate', { method: 'POST', body: JSON.stringify(payload) });
    const cls = result.isProfitable ? 'pos' : 'neg';
    document.getElementById('marginCalcResult').innerHTML = `
      <div class="kpi-grid" style="margin-top:14px">
        <div class="kpi-card"><div class="kpi-card__label">Комиссия Kaspi</div><div class="kpi-card__value">${fmtMoney(result.commission)}</div></div>
        <div class="kpi-card"><div class="kpi-card__label">Логистика</div><div class="kpi-card__value">${fmtMoney(result.logistics)}</div></div>
        <div class="kpi-card kpi-card--accent"><div class="kpi-card__label">Чистая прибыль</div><div class="kpi-card__value ${cls}">${fmtMoney(result.netProfit)}</div></div>
        <div class="kpi-card"><div class="kpi-card__label">Маржа</div><div class="kpi-card__value ${cls}">${result.marginPct}%</div></div>
        <div class="kpi-card"><div class="kpi-card__label">ROI</div><div class="kpi-card__value ${cls}">${result.roiPct}%</div></div>
      </div>
    `;
  });
}

async function loadMarginPage() {
  wireMarginFormOnce();
  await loadKaspiCategoriesIntoSelect(document.getElementById('marginCategorySelect'));
}

// =====================================================================
// ДЕМПИНГ
// =====================================================================
let repricerRowsWired = false;
let runRepricerBtnWired = false;

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

  const total = kaspiProducts.length;
  const active = kaspiProducts.filter((p) => p.autoRepriceEnabled).length;
  const ready = kaspiProducts.filter((p) => p.autoRepriceEnabled && p.kaspiProductUrl && p.minPrice != null).length;

  document.getElementById('dempingStats').innerHTML = kpiCardsHtml([
    { label: 'Всего правил', value: fmt.format(total) },
    { label: 'Активных', value: fmt.format(active), accent: active > 0 },
    { label: 'Готовы применить', value: fmt.format(ready) },
  ]);

  const tbody = document.querySelector('#repricerTable tbody');
  if (!kaspiProducts.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-faint)">Сначала добавь товары с артикулом Kaspi в разделе «Товары»</td></tr>`;
    return;
  }

  tbody.innerHTML = kaspiProducts.map((p) => `
    <tr data-id="${p.id}">
      <td class="name-cell">${p.name}</td>
      <td><input class="cost-input" style="width:180px" type="url" placeholder="https://kaspi.kz/shop/p/..." value="${p.kaspiProductUrl ?? ''}" data-field="kaspiProductUrl" /></td>
      <td class="num"><input class="cost-input" type="number" step="1" placeholder="—" value="${p.minPrice ?? ''}" data-field="minPrice" /></td>
      <td class="num"><input class="cost-input" type="number" step="1" value="${p.repriceStep ?? 1}" data-field="repriceStep" /></td>
      <td class="num">${p.currentKaspiPrice ? fmtMoney(p.currentKaspiPrice) : '—'}</td>
      <td><input type="checkbox" data-field="autoRepriceEnabled" ${p.autoRepriceEnabled ? 'checked' : ''} /></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('input').forEach((input) => {
      const evt = input.type === 'checkbox' ? 'change' : 'blur';
      input.addEventListener(evt, async () => {
        const field = input.dataset.field;
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (input.type === 'number') value = value === '' ? null : Number(value);
        if (input.type === 'url' && value === '') value = null;
        await api(`/repricer/${id}/settings`, { method: 'PUT', body: JSON.stringify({ [field]: value }) });
        if (input.dataset.field === 'autoRepriceEnabled') await loadDempingPage();
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
async function loadSettingsPage() {
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
  btn.textContent = '…'; btn.disabled = true;
  try {
    await api('/sync/kaspi?days=7', { method: 'POST' });
    await reloadCurrentPage();
  } finally {
    btn.textContent = '↻ Kaspi'; btn.disabled = false;
  }
});

document.getElementById('syncOzonBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncOzonBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    await api('/sync/ozon?days=7', { method: 'POST' });
    await reloadCurrentPage();
  } finally {
    btn.textContent = '↻ Ozon'; btn.disabled = false;
  }
});

document.getElementById('syncWbBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncWbBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    await api('/sync/wb?days=7', { method: 'POST' });
    await reloadCurrentPage();
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
