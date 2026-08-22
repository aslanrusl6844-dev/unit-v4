const state = {
  marketplace: '',
  from: null,
  to: null,
  groupBy: 'day',
  chart: null,
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
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  if (res.status === 204) return null;
  return res.json();
}

function qs(params) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  return p.toString();
}

// ---------- Waterfall (signature visual) ----------
function renderWaterfall(summary) {
  const el = document.getElementById('waterfall');
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
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--surface-2);border:1px solid var(--border)"></span>Выручка</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:rgba(226,96,74,0.5)"></span>Себестоимость ${fmtMoney(cogs)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:rgba(226,96,74,0.5)"></span>Комиссии/логистика ${fmtMoney(fees)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:rgba(226,96,74,0.5)"></span>Реклама и прочее ${fmtMoney(ads)}</div>
      <div class="wf-legend__item"><span class="wf-legend__swatch" style="background:var(--profit)"></span>Чистая прибыль</div>
    </div>
  `;
}

// ---------- KPI cards ----------
function renderKpis(summary) {
  const items = [
    { label: 'Выручка', value: fmtMoney(summary.revenue), cls: '' },
    { label: 'Себестоимость', value: fmtMoney(summary.cogs), cls: '' },
    { label: 'Комиссии площадки', value: fmtMoney(summary.marketplaceCommission), cls: '' },
    { label: 'Логистика', value: fmtMoney(summary.logisticsCost), cls: '' },
    { label: 'Реклама', value: fmtMoney(summary.adSpend), cls: '' },
    { label: 'Прочие расходы', value: fmtMoney(summary.manualExpenses), cls: '' },
    { label: 'Чистая прибыль', value: fmtMoney(summary.netProfit), cls: summary.netProfit >= 0 ? 'pos' : 'neg', accent: true },
    { label: 'Маржа', value: fmtPct(summary.marginPct), cls: summary.marginPct >= 0 ? 'pos' : 'neg' },
    { label: 'ROI', value: fmtPct(summary.roiPct), cls: summary.roiPct >= 0 ? 'pos' : 'neg' },
    { label: 'Средний чек', value: fmtMoney(summary.aov), cls: '' },
    { label: 'Заказов', value: fmt.format(summary.ordersCount || 0), cls: '' },
  ];

  document.getElementById('kpiGrid').innerHTML = items.map((i) => `
    <div class="kpi-card ${i.accent ? 'kpi-card--accent' : ''}">
      <div class="kpi-card__label">${i.label}</div>
      <div class="kpi-card__value ${i.cls}">${i.value}</div>
    </div>
  `).join('');
}

// ---------- Trend chart ----------
async function loadTrend() {
  const data = await api(`/analytics/timeseries?${qs({ from: state.from, to: state.to, marketplace: state.marketplace, groupBy: state.groupBy })}`);
  const ctx = document.getElementById('trendChart');

  const labels = data.map((d) => d.date);
  const revenue = data.map((d) => d.revenue);
  const profit = data.map((d) => d.profit);

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'line', label: 'Выручка', data: revenue, borderColor: '#89969C', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        { type: 'bar', label: 'Прибыль', data: profit, backgroundColor: profit.map((p) => (p >= 0 ? 'rgba(62,207,142,0.65)' : 'rgba(226,96,74,0.65)')), borderRadius: 3, maxBarThickness: 28 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#89969C', font: { family: 'Inter', size: 11 } } },
      },
      scales: {
        x: { ticks: { color: '#5C686E', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#1C2429' } },
        y: { ticks: { color: '#5C686E', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#1C2429' } },
      },
    },
  });
}

// ---------- Products (unit economics table) ----------
async function loadByProduct() {
  const data = await api(`/analytics/by-product?${qs({ from: state.from, to: state.to, marketplace: state.marketplace })}`);
  const tbody = document.querySelector('#productsTable tbody');
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="name-cell" style="color:var(--text-faint)">Нет данных за период</td></tr>`;
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

// ---------- Recent orders ----------
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
  if (o.status === 'ASSEMBLE') return `<span style="color:var(--profit);font-size:12px">✓ Накладная сформирована</span>`;
  return '—';
}

// ---------- Products admin ----------
async function loadKaspiCategoriesIntoSelect() {
  const select = document.getElementById('kaspiTopCategorySelect');
  if (!select || select.dataset.loaded) return;
  const categories = await api('/products/kaspi-categories');
  categories
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = `${c.name} (${c.rate}%)`;
      select.appendChild(opt);
    });
  select.dataset.loaded = '1';
}

async function loadProductsAdmin() {
  await loadKaspiCategoriesIntoSelect();
  const products = await api('/products');
  const tbody = document.querySelector('#productsAdminTable tbody');
  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-faint)">Товары ещё не добавлены</td></tr>`;
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
      <td><button class="link-btn" data-action="delete">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('input[data-field="costPrice"]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ costPrice: Number(e.target.value) }) });
      refreshAll();
    });
  });
  tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      if (!confirm('Удалить товар?')) return;
      await api(`/products/${id}`, { method: 'DELETE' });
      loadProductsAdmin();
    });
  });
}

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
    await loadProductsAdmin();
  } catch (err) {
    alert('Не удалось добавить товар: ' + err.message);
  } finally {
    btn.textContent = originalText; btn.disabled = false;
  }
});

// ---------- Expenses ----------
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
      refreshAll();
    });
  });
}

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
  refreshAll();
});

// ---------- Sync ----------
async function refreshSyncStatus() {
  const status = await api('/sync/status');
  const el = document.getElementById('syncStatus');
  el.textContent = `Kaspi API: ${status.kaspi.configured ? 'подключён' : 'не настроен'} · Ozon API: ${status.ozon.configured ? 'подключён' : 'не настроен'} · WB API: ${status.wb.configured ? 'подключён' : 'не настроен'} · автосинхронизация: ${status.cron}`;
}

document.getElementById('syncKaspiBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncKaspiBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    await api('/sync/kaspi?days=7', { method: 'POST' });
    await refreshAll();
  } finally {
    btn.textContent = '↻ Kaspi'; btn.disabled = false;
  }
});

document.getElementById('syncOzonBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncOzonBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    await api('/sync/ozon?days=7', { method: 'POST' });
    await refreshAll();
  } finally {
    btn.textContent = '↻ Ozon'; btn.disabled = false;
  }
});

document.getElementById('syncWbBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncWbBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    await api('/sync/wb?days=7', { method: 'POST' });
    await refreshAll();
  } finally {
    btn.textContent = '↻ WB'; btn.disabled = false;
  }
});

// ---------- Filters wiring ----------
document.getElementById('mpFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('.mp-filter__btn');
  if (!btn) return;
  document.querySelectorAll('.mp-filter__btn').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  state.marketplace = btn.dataset.mp;
  refreshAll();
});

document.querySelectorAll('.range-picker__presets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-picker__presets button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const days = Number(btn.dataset.days);
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    document.getElementById('dateTo').value = todayISO(to);
    document.getElementById('dateFrom').value = todayISO(from);
    state.from = todayISO(from);
    state.to = todayISO(to);
    refreshAll();
  });
});

['dateFrom', 'dateTo'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    state.from = document.getElementById('dateFrom').value;
    state.to = document.getElementById('dateTo').value;
    refreshAll();
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

// ---------- Repricer (автобот цены на Kaspi) ----------
async function loadRepricerPanel() {
  const products = await api('/products');
  const tbody = document.querySelector('#repricerTable tbody');
  const kaspiProducts = products.filter((p) => p.kaspiSku);

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
      });
    });
  });
}

document.getElementById('runRepricerBtn').addEventListener('click', async () => {
  const btn = document.getElementById('runRepricerBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const res = await api('/repricer/run', { method: 'POST' });
    alert(`Проверено товаров: ${res.results.length}. Изменена цена у: ${res.results.filter(r => r.changed).length}.`);
    loadRepricerPanel();
  } catch (e) {
    alert('Ошибка: ' + e.message);
  } finally {
    btn.textContent = '▶ Проверить цены сейчас'; btn.disabled = false;
  }
});

// ---------- Быстрый калькулятор маржи ----------
async function loadMarginCategories() {
  const select = document.getElementById('marginCategorySelect');
  if (select.dataset.loaded) return;
  const categories = await api('/margin-calculator/categories');
  categories
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = `${c.name} (${c.rate}%)`;
      select.appendChild(opt);
    });
  select.dataset.loaded = '1';
}

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

// ---------- Отзывы ----------
async function loadReviewsPanel() {
  const reviews = await api('/reviews');
  const tbody = document.querySelector('#reviewsTable tbody');
  if (!reviews.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-faint)">Добавь ссылку на Kaspi в разделе «Автобот цены», чтобы видеть отзывы</td></tr>`;
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
      loadReviewsPanel();
    });
  });
}

document.getElementById('refreshReviewsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshReviewsBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    await api('/reviews/refresh-all', { method: 'POST' });
    loadReviewsPanel();
  } finally {
    btn.textContent = '↻ Обновить всё'; btn.disabled = false;
  }
});

// ---------- Main refresh ----------
async function refreshAll() {
  const summaryResp = await api(`/analytics/summary?${qs({ from: state.from, to: state.to, marketplace: state.marketplace })}`);
  const summary = state.marketplace ? summaryResp : summaryResp.total;
  renderWaterfall(summary);
  renderKpis(summary);
  await Promise.all([loadTrend(), loadByProduct(), loadOrders(), loadExpenses()]);
}

(async function init() {
  initDateRange();
  document.getElementById('priceFeedUrl').textContent = `${window.location.origin}/api/kaspi/price-feed.xml?token=ВАШ_PRICE_FEED_SECRET`;
  document.getElementById('expenseForm').date && (document.querySelector('#expenseForm input[name="date"]').value = todayISO());
  await Promise.all([refreshAll(), loadProductsAdmin(), loadRepricerPanel(), loadMarginCategories(), loadReviewsPanel(), loadOrdersMeta(), refreshSyncStatus()]);
})();
