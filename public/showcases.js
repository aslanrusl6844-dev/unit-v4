// ---------------------------------------------------------------------
// My Market → «Подбаннерные витрины»: витрины брендов и магазинов под главным
// баннером приложения. Данные — /api/shop-admin/showcases (вход администратора
// Basic, тот же, что у всей панели). Картинки грузятся тем же uploadMyMarketFile
// (Vercel Blob), что и фото товаров. Товары каталога этим экраном НЕ создаются
// и НЕ удаляются: витрина хранит только ссылки на них.
// Использует глобальные api() и uploadMyMarketFile() из dashboard.js (вызываются
// уже после загрузки обоих скриптов — при открытии вкладки).
// ---------------------------------------------------------------------
const scState = { list: [], q: '', current: null, editingNew: false, status: '', statusKind: '', wired: false, busy: false };
const scEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scErr = (err) => (err && err.body && err.body.error) ? String(err.body.error) : String((err && err.message) || err);
const scTypeName = (t) => (t === 'shop' ? 'Магазин' : 'Бренд');

function scRoot() { return document.getElementById('scRoot'); }

function scSetStatus(text, kind) {
  scState.status = text || '';
  scState.statusKind = kind || '';
  const el = document.getElementById('scStatus');
  if (!el) return;
  el.style.color = kind === 'error' ? 'var(--loss)' : 'var(--text-muted)';
  el.textContent = text || '';
}

function scThumb(url) {
  return url
    ? `<img src="${scEsc(url)}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:8px;border:1px solid var(--border)" />`
    : '<span style="display:inline-block;width:40px;height:40px;border-radius:8px;border:1px dashed var(--border)"></span>';
}

async function loadShowcases() {
  scWireOnce();
  try {
    scState.list = await api(`/shop-admin/showcases${scState.q ? `?q=${encodeURIComponent(scState.q)}` : ''}`);
    scSetStatus('', '');
  } catch (err) {
    scState.list = [];
    scSetStatus(`Не удалось загрузить витрины: ${scErr(err)}`, 'error');
  }
  scRender();
}

function scRender() {
  const root = scRoot();
  if (!root) return;
  const hadSearchFocus = document.activeElement && document.activeElement.id === 'scSearch';
  root.innerHTML = scState.current || scState.editingNew ? scEditorHtml() : scListHtml();
  if (hadSearchFocus) {
    const el = document.getElementById('scSearch');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
}

// ----------------------------- список -----------------------------
function scListHtml() {
  const rows = scState.list.map((s, i) => `
    <tr data-id="${scEsc(s.id)}">
      <td>${scThumb(s.logoUrl)}</td>
      <td><b>${scEsc(s.title)}</b><div class="panel__hint" style="margin:0">${scTypeName(s.type)} · товаров: ${s._count ? s._count.products : 0} · подборок: ${s._count ? s._count.collections : 0}</div></td>
      <td>${s.published ? '<span style="color:var(--profit)">Опубликована</span>' : '<span style="color:var(--text-muted)">Скрыта</span>'}</td>
      <td style="white-space:nowrap">
        <button type="button" class="btn btn--ghost" data-sc="up" ${i === 0 ? 'disabled' : ''} title="Выше">↑</button>
        <button type="button" class="btn btn--ghost" data-sc="down" ${i === scState.list.length - 1 ? 'disabled' : ''} title="Ниже">↓</button>
        <button type="button" class="btn btn--ghost" data-sc="toggle">${s.published ? 'Скрыть' : 'Опубликовать'}</button>
        <button type="button" class="btn btn--ghost" data-sc="edit">Открыть</button>
        <button type="button" class="btn btn--ghost" data-sc="delete">Удалить</button>
      </td>
    </tr>`).join('');
  return `
    <div class="panel__head" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <h2>Подбаннерные витрины</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="text" id="scSearch" placeholder="Поиск по названию" value="${scEsc(scState.q)}" style="max-width:220px" />
        <button type="button" class="btn btn--accent" data-sc="new">Новая витрина</button>
      </div>
    </div>
    <p class="panel__hint">Иконки брендов и магазинов под главным баннером приложения. Порядок здесь = порядок в приложении. Удаление витрины не удаляет товары из каталога.</p>
    <p id="scStatus" class="panel__hint" style="color:${scState.statusKind === 'error' ? 'var(--loss)' : 'var(--text-muted)'}">${scEsc(scState.status)}</p>
    ${scState.list.length ? `<table class="table"><tbody>${rows}</tbody></table>` : '<p class="panel__hint">Витрин пока нет.</p>'}`;
}

// ----------------------------- редактор -----------------------------
function scEditorHtml() {
  const c = scState.current || { type: 'brand', title: '', description: '', logoUrl: '', bannerUrl: '', bannerTitle: '', bannerText: '', published: false, products: [], collections: [] };
  const isNew = !scState.current;
  return `
    <div class="panel__head" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <h2>${isNew ? 'Новая витрина' : scEsc(c.title)}</h2>
      <button type="button" class="btn btn--ghost" data-sc="back">← К списку</button>
    </div>
    <p id="scStatus" class="panel__hint" style="color:${scState.statusKind === 'error' ? 'var(--loss)' : 'var(--text-muted)'}">${scEsc(scState.status)}</p>
    <form id="scForm" style="display:grid;gap:10px;max-width:640px">
      <label>Тип
        <select id="scType"><option value="brand" ${c.type === 'brand' ? 'selected' : ''}>Бренд</option><option value="shop" ${c.type === 'shop' ? 'selected' : ''}>Магазин</option></select>
      </label>
      <label>Название <input type="text" id="scTitle" maxlength="120" value="${scEsc(c.title)}" /></label>
      <label>Короткое описание <input type="text" id="scDescription" maxlength="500" value="${scEsc(c.description)}" /></label>
      <div>Логотип / иконка<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${scThumb(c.logoUrl)}
        <input type="file" id="scLogoFile" accept="image/jpeg,image/png,image/webp" />
        <input type="text" id="scLogoUrl" placeholder="или ссылка на картинку" value="${scEsc(c.logoUrl)}" style="max-width:260px" /></div></div>
      <div>Рекламный баннер<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${scThumb(c.bannerUrl)}
        <input type="file" id="scBannerFile" accept="image/jpeg,image/png,image/webp" />
        <input type="text" id="scBannerUrl" placeholder="или ссылка на картинку" value="${scEsc(c.bannerUrl)}" style="max-width:260px" /></div></div>
      <label>Заголовок баннера <input type="text" id="scBannerTitle" maxlength="120" value="${scEsc(c.bannerTitle)}" /></label>
      <label>Рекламный текст <textarea id="scBannerText" rows="3" maxlength="1000">${scEsc(c.bannerText)}</textarea></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="scPublished" ${c.published ? 'checked' : ''} /> Опубликована (видна в приложении)</label>
      <div><button type="submit" class="btn btn--accent" id="scSave">${isNew ? 'Создать' : 'Сохранить'}</button></div>
    </form>
    ${isNew ? '<p class="panel__hint">Товары и подборки можно добавить после создания витрины.</p>' : scProductsHtml(c) + scCollectionsHtml(c)}`;
}

function scProductRows(products, scope) {
  if (!products.length) return '<p class="panel__hint">Пока пусто.</p>';
  return `<table class="table"><tbody>${products.map((p, i) => `
    <tr data-pid="${scEsc(p.id)}">
      <td>${scThumb(p.image)}</td>
      <td>${scEsc(p.name)}<div class="panel__hint" style="margin:0">${scEsc(p.article || p.sku || p.id)}${p.price != null ? ` · ${scEsc(p.price)} ₸` : ''}${p.missing ? ' · нет в каталоге' : (!p.shopActive || p.shopArchived ? ' · не в продаже (покупателю не виден)' : '')}</div></td>
      <td style="white-space:nowrap">
        <button type="button" class="btn btn--ghost" data-sc="${scope}-up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn btn--ghost" data-sc="${scope}-down" ${i === products.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn btn--ghost" data-sc="${scope}-remove">Убрать</button>
      </td>
    </tr>`).join('')}</tbody></table>`;
}

function scSearchBox(scope, cid) {
  return `<div class="inline-form" style="gap:8px;margin:8px 0;flex-wrap:wrap" data-scope="${scope}" ${cid ? `data-cid="${scEsc(cid)}"` : ''}>
    <input type="text" class="sc-psearch" placeholder="Найти товар по названию, ID или артикулу" style="max-width:320px" />
    <button type="button" class="btn btn--ghost" data-sc="psearch">Найти</button>
    <div class="sc-presults" style="flex-basis:100%"></div></div>`;
}

function scProductsHtml(c) {
  return `<div style="margin-top:22px;border-top:1px solid var(--border);padding-top:14px">
    <h3 style="margin:0 0 6px">Товары витрины (${c.products.length})</h3>
    <p class="panel__hint">Только товары, добавленные здесь. Один товар может быть в нескольких витринах; убрать товар из витрины не значит удалить его из каталога.</p>
    ${scSearchBox('products', '')}
    <div id="scProducts">${scProductRows(c.products, 'p')}</div></div>`;
}

function scCollectionsHtml(c) {
  const blocks = c.collections.map((col, i) => `
    <div class="sc-collection" data-cid="${scEsc(col.id)}" style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:space-between">
        <b>${scEsc(col.title)}</b>
        <span style="white-space:nowrap">
          <button type="button" class="btn btn--ghost" data-sc="col-up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn btn--ghost" data-sc="col-down" ${i === c.collections.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn btn--ghost" data-sc="col-toggle">${col.published ? 'Скрыть' : 'Опубликовать'}</button>
          <button type="button" class="btn btn--ghost" data-sc="col-rename">Переименовать</button>
          <button type="button" class="btn btn--ghost" data-sc="col-delete">Удалить</button>
        </span>
      </div>
      <div class="panel__hint" style="margin:4px 0">${col.published ? 'Показывается' : 'Скрыта'} · товаров: ${col.products.length}</div>
      ${scSearchBox('items', col.id)}
      ${scProductRows(col.products, 'i')}
    </div>`).join('');
  return `<div style="margin-top:22px;border-top:1px solid var(--border);padding-top:14px">
    <h3 style="margin:0 0 6px">Рекламные подборки</h3>
    <p class="panel__hint">Например «Новинки», «Хиты продаж». Подборка показывается на странице витрины в этом порядке.</p>
    <div class="inline-form" style="gap:8px;margin-bottom:10px"><input type="text" id="scNewCol" placeholder="Название подборки" maxlength="120" style="max-width:260px" />
      <button type="button" class="btn btn--accent" data-sc="col-new">Добавить подборку</button></div>
    ${blocks || '<p class="panel__hint">Подборок пока нет.</p>'}</div>`;
}

// ----------------------------- действия -----------------------------
function scFormData() {
  const v = (id) => document.getElementById(id).value;
  return {
    type: v('scType'),
    title: v('scTitle').trim(),
    description: v('scDescription').trim() || null,
    logoUrl: v('scLogoUrl').trim() || null,
    bannerUrl: v('scBannerUrl').trim() || null,
    bannerTitle: v('scBannerTitle').trim() || null,
    bannerText: v('scBannerText').trim() || null,
    published: document.getElementById('scPublished').checked,
  };
}

async function scUploadInto(fileInputId, urlInputId) {
  const file = document.getElementById(fileInputId).files[0];
  if (!file) return;
  scSetStatus('Загружаю картинку…', '');
  const url = await uploadMyMarketFile(file);
  document.getElementById(urlInputId).value = url;
}

async function scSave() {
  if (scState.busy) return;
  scState.busy = true;
  try {
    await scUploadInto('scLogoFile', 'scLogoUrl');
    await scUploadInto('scBannerFile', 'scBannerUrl');
    const data = scFormData();
    if (!data.title) throw new Error('Укажите название');
    if (scState.current) {
      await api(`/shop-admin/showcases/${encodeURIComponent(scState.current.id)}`, { method: 'PATCH', body: JSON.stringify(data) });
      await scOpen(scState.current.id, 'Сохранено');
    } else {
      const created = await api('/shop-admin/showcases', { method: 'POST', body: JSON.stringify(data) });
      scState.editingNew = false;
      await scOpen(created.id, 'Витрина создана');
    }
  } catch (err) {
    scSetStatus(`Не удалось сохранить: ${scErr(err)}`, 'error');
  } finally {
    scState.busy = false;
  }
}

async function scOpen(id, okText) {
  try {
    scState.current = await api(`/shop-admin/showcases/${encodeURIComponent(id)}`);
    scState.status = okText || '';
    scState.statusKind = '';
  } catch (err) {
    scState.status = `Не удалось открыть витрину: ${scErr(err)}`;
    scState.statusKind = 'error';
  }
  scRender();
}

async function scReorderList(index, delta) {
  const ids = scState.list.map((s) => s.id);
  const j = index + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[index], ids[j]] = [ids[j], ids[index]];
  await api('/shop-admin/showcases/order', { method: 'PUT', body: JSON.stringify({ ids }) });
  await loadShowcases();
}

async function scMove(arr, pid, delta, url, key) {
  const ids = arr.map((p) => p.id);
  const i = ids.indexOf(pid);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await api(url, { method: 'PUT', body: JSON.stringify({ [key]: ids }) });
  await scOpen(scState.current.id);
}

async function scPSearch(box) {
  const q = box.querySelector('.sc-psearch').value.trim();
  const out = box.querySelector('.sc-presults');
  if (!q) { out.innerHTML = ''; return; }
  try {
    const rows = await api(`/shop-admin/showcases/product-search?q=${encodeURIComponent(q)}`);
    out.innerHTML = rows.length
      ? rows.map((p) => `<div data-pid="${scEsc(p.id)}" style="display:flex;gap:8px;align-items:center;margin:4px 0">${scThumb(p.image)}<span style="flex:1">${scEsc(p.name)} <span class="panel__hint" style="margin:0">${scEsc(p.article || p.sku)}</span></span><button type="button" class="btn btn--ghost" data-sc="padd">Добавить</button></div>`).join('')
      : '<span class="panel__hint">Ничего не найдено</span>';
  } catch (err) {
    out.innerHTML = `<span style="color:var(--loss)">${scEsc(scErr(err))}</span>`;
  }
}

async function scHandleClick(e) {
  const btn = e.target.closest('[data-sc]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.sc;
  const base = scState.current ? `/shop-admin/showcases/${encodeURIComponent(scState.current.id)}` : '';
  const row = btn.closest('tr');
  const pid = row && row.dataset.pid;
  const colEl = btn.closest('.sc-collection');
  const cid = colEl && colEl.dataset.cid;
  const col = cid && scState.current && scState.current.collections.find((x) => x.id === cid);
  try {
    if (act === 'new') { scState.editingNew = true; scState.current = null; scSetStatus('', ''); scRender(); }
    else if (act === 'back') { scState.current = null; scState.editingNew = false; await loadShowcases(); }
    else if (act === 'edit') await scOpen(row.dataset.id);
    else if (act === 'up' || act === 'down') {
      await scReorderList(scState.list.findIndex((s) => s.id === row.dataset.id), act === 'up' ? -1 : 1);
    } else if (act === 'toggle') {
      const s = scState.list.find((x) => x.id === row.dataset.id);
      await api(`/shop-admin/showcases/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: JSON.stringify({ published: !s.published }) });
      await loadShowcases();
    } else if (act === 'delete') {
      const s = scState.list.find((x) => x.id === row.dataset.id);
      if (!window.confirm(`Удалить витрину «${s.title}»? Товары в каталоге останутся, удалятся только витрина, её подборки и привязки.`)) return;
      await api(`/shop-admin/showcases/${encodeURIComponent(s.id)}?confirm=1`, { method: 'DELETE' });
      await loadShowcases();
    } else if (act === 'psearch') await scPSearch(btn.closest('[data-scope]'));
    else if (act === 'padd') {
      const box = btn.closest('[data-scope]');
      const productId = btn.parentElement.dataset.pid;
      const url = box.dataset.scope === 'items' ? `${base}/collections/${encodeURIComponent(box.dataset.cid)}/items` : `${base}/products`;
      await api(url, { method: 'POST', body: JSON.stringify({ productId }) });
      await scOpen(scState.current.id, 'Товар добавлен');
    } else if (act === 'p-up' || act === 'p-down') {
      await scMove(scState.current.products, pid, act === 'p-up' ? -1 : 1, `${base}/products/order`, 'productIds');
    } else if (act === 'p-remove') {
      await api(`${base}/products/${encodeURIComponent(pid)}`, { method: 'DELETE' });
      await scOpen(scState.current.id, 'Товар убран из витрины (в каталоге остался)');
    } else if (act === 'i-up' || act === 'i-down') {
      await scMove(col.products, pid, act === 'i-up' ? -1 : 1, `${base}/collections/${encodeURIComponent(cid)}/items/order`, 'productIds');
    } else if (act === 'i-remove') {
      await api(`${base}/collections/${encodeURIComponent(cid)}/items/${encodeURIComponent(pid)}`, { method: 'DELETE' });
      await scOpen(scState.current.id, 'Товар убран из подборки (в каталоге остался)');
    } else if (act === 'col-new') {
      const input = document.getElementById('scNewCol');
      const title = input.value.trim();
      if (!title) { scSetStatus('Введите название подборки', 'error'); return; }
      await api(`${base}/collections`, { method: 'POST', body: JSON.stringify({ title }) });
      await scOpen(scState.current.id, 'Подборка добавлена');
    } else if (act === 'col-up' || act === 'col-down') {
      await scMove(scState.current.collections, cid, act === 'col-up' ? -1 : 1, `${base}/collections/order`, 'ids');
    } else if (act === 'col-toggle') {
      await api(`${base}/collections/${encodeURIComponent(cid)}`, { method: 'PATCH', body: JSON.stringify({ published: !col.published }) });
      await scOpen(scState.current.id);
    } else if (act === 'col-rename') {
      const title = window.prompt('Новое название подборки', col.title);
      if (title === null || !title.trim()) return;
      await api(`${base}/collections/${encodeURIComponent(cid)}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) });
      await scOpen(scState.current.id);
    } else if (act === 'col-delete') {
      if (!window.confirm(`Удалить подборку «${col.title}»? Товары каталога и витрины останутся.`)) return;
      await api(`${base}/collections/${encodeURIComponent(cid)}`, { method: 'DELETE' });
      await scOpen(scState.current.id, 'Подборка удалена');
    }
  } catch (err) {
    scSetStatus(scErr(err), 'error');
  }
}

function scWireOnce() {
  if (scState.wired) return;
  const root = scRoot();
  if (!root) return;
  scState.wired = true;
  root.addEventListener('click', scHandleClick);
  root.addEventListener('submit', (e) => {
    if (e.target.id === 'scForm') { e.preventDefault(); scSave(); }
  });
  let timer = null;
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'scSearch') return;
    scState.q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(loadShowcases, 300);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('sc-psearch')) {
      e.preventDefault();
      scPSearch(e.target.closest('[data-scope]'));
    }
  });
}
