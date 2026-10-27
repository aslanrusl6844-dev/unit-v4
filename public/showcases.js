// ---------------------------------------------------------------------
// My Market → «Подбаннерные витрины»: витрины брендов и магазинов под главным
// баннером приложения. Данные — /api/shop-admin/showcases (вход администратора
// Basic, тот же, что у всей панели). Картинки грузятся тем же uploadMyMarketFile
// (Vercel Blob), что и фото товаров. Товары каталога этим экраном НЕ создаются
// и НЕ удаляются: витрина хранит только ссылки на них.
// Использует глобальные api() и uploadMyMarketFile() из dashboard.js (вызываются
// уже после загрузки обоих скриптов — при открытии вкладки).
// ---------------------------------------------------------------------
const scState = { list: [], q: '', current: null, editingNew: false, status: '', statusKind: '', wired: false, busy: false, loading: false, loadError: null };
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

let scLoadSeq = 0;
async function loadShowcases() {
  scWireOnce();
  const seq = ++scLoadSeq; // быстрый ввод в поиске: устаревший ответ не затирает свежий
  scState.loading = true;
  scState.loadError = null;
  scRender();
  try {
    const list = await api(`/shop-admin/showcases${scState.q ? `?q=${encodeURIComponent(scState.q)}` : ''}`);
    if (seq !== scLoadSeq) return;
    scState.list = list;
    scSetStatus('', '');
  } catch (err) {
    if (seq !== scLoadSeq) return;
    scState.list = [];
    scState.loadError = `Не удалось загрузить витрины: ${scErr(err)}`;
  }
  scState.loading = false;
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
        <button type="button" class="btn btn--ghost" data-sc="up" ${i === 0 || scState.q ? 'disabled' : ''} title="${scState.q ? 'Порядок меняется без поиска' : 'Выше'}">↑</button>
        <button type="button" class="btn btn--ghost" data-sc="down" ${i === scState.list.length - 1 || scState.q ? 'disabled' : ''} title="${scState.q ? 'Порядок меняется без поиска' : 'Ниже'}">↓</button>
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
    ${scState.loadError
      ? `<p style="color:var(--loss)">${scEsc(scState.loadError)}</p><button type="button" class="btn btn--accent" data-sc="reload">Повторить</button>`
      : scState.loading && !scState.list.length
        ? '<p class="panel__hint">Загрузка…</p>'
        : scState.list.length
          ? `<table class="table"><tbody>${rows}</tbody></table>`
          : `<p class="panel__hint">${scState.q ? 'Ничего не найдено.' : 'Витрин пока нет.'}</p>`}`;
}

// ----------------------------- редактор -----------------------------
const SC_MAX_BANNERS = 10;

// Две карусели с одним интерфейсом: 'big' (bigBanners, сверху) и 'small' (banners, ниже).
const SC_LISTS = {
  big: { field: 'bigBanners', box: 'scBigBanners', file: 'scBigAddFile', url: 'scBigAddUrl' },
  small: { field: 'banners', box: 'scBanners', file: 'scBannerAddFile', url: 'scBannerAddUrl' },
};
function scList(kind) {
  const f = SC_LISTS[kind].field;
  return scState[f] || (scState[f] = []);
}

// Большая карусель: у каждого баннера есть строки текста (у каждой свой размер, %) и цвет текста
// (параллельные массивы, тот же порядок, что bigBanners).
const SC_DEFAULT_SIZE = 20;
const scClampSize = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : SC_DEFAULT_SIZE;
};
function scBigExtras() {
  const n = scList('big').length;
  const lines = scState.bigBannerLines || (scState.bigBannerLines = []);
  const colors = scState.bigBannerTextColors || (scState.bigBannerTextColors = []);
  while (lines.length < n) lines.push([{ t: '', s: SC_DEFAULT_SIZE }]);
  while (colors.length < n) colors.push('white');
  lines.length = n; colors.length = n;
  lines.forEach((l, i) => { if (!l.length) lines[i] = [{ t: '', s: SC_DEFAULT_SIZE }]; });
  return [lines, colors];
}
// Текст с сервера ("A\nB") + размеры ("30,15") → строки редактора; нет размеров — по 20.
function scLinesFrom(text, sizesCsv) {
  const sizes = String(sizesCsv || '').split(',');
  const parts = String(text || '').split('\n');
  return parts.map((t, j) => ({ t, s: scClampSize(sizes[j] === undefined || sizes[j].trim() === '' ? NaN : sizes[j]) }));
}

function scBannersHtml(kind) {
  const list = scList(kind || 'small');
  const extras = (kind === 'big') ? scBigExtras() : null;
  if (!list.length) return '<p class="panel__hint" style="margin:4px 0">Баннеров пока нет.</p>';
  return `<table class="table"><tbody>${list.map((u, i) => `
    <tr data-bi="${i}">
      <td>${scThumb(u)}</td>
      <td style="word-break:break-all">${scEsc(u)}${extras ? `
        <div style="margin-top:4px">
          ${extras[0][i].map((ln, j) => `
          <div class="sc-bb-lrow" data-li="${j}" style="display:flex;gap:6px;align-items:center;margin:3px 0">
            <input type="text" class="sc-bb-line" maxlength="60" placeholder="Строка ${j + 1}" value="${scEsc(ln.t)}" style="flex:1;min-width:120px;max-width:260px" />
            <label style="white-space:nowrap;font-size:12px">Размер <input type="number" class="sc-bb-size" min="1" max="100" step="1" value="${ln.s}" style="width:64px" /></label>
            <button type="button" class="btn btn--ghost" data-sc="bl-remove" title="Убрать строку" ${extras[0][i].length === 1 ? 'disabled' : ''}>×</button>
          </div>`).join('')}
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap">
            <button type="button" class="btn btn--ghost" data-sc="bl-add">＋ Строка</button>
            <select class="sc-bb-color" title="Цвет текста">
              <option value="white"${extras[1][i] === 'black' ? '' : ' selected'}>Белый текст</option>
              <option value="black"${extras[1][i] === 'black' ? ' selected' : ''}>Чёрный текст</option>
            </select></div></div>` : ''}</td>
      <td style="white-space:nowrap">
        <button type="button" class="btn btn--ghost" data-sc="b-up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn btn--ghost" data-sc="b-down" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn btn--ghost" data-sc="b-remove">Убрать</button>
      </td>
    </tr>`).join('')}</tbody></table>`;
}

function scBannersRefresh(kind) {
  const el = document.getElementById(SC_LISTS[kind || 'small'].box);
  if (el) el.innerHTML = scBannersHtml(kind || 'small');
}

function scBannersBlockHtml(kind, label, isNew) {
  const L = SC_LISTS[kind];
  return `<div>${label}
        <div id="${L.box}" data-blist="${kind}">${scBannersHtml(kind)}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px" data-blist="${kind}">
          <input type="file" id="${L.file}" accept="image/jpeg,image/png,image/webp" />
          <input type="text" id="${L.url}" placeholder="или ссылка на картинку (https://…)" style="max-width:260px" />
          <button type="button" class="btn btn--ghost" data-sc="b-add">Добавить баннер</button></div>
        <p class="panel__hint" style="margin:4px 0 0">До ${SC_MAX_BANNERS} баннеров, порядок задают стрелки. Изменения сохраняются кнопкой «${isNew ? 'Создать' : 'Сохранить'}».</p></div>`;
}

const SC_MAX_VIDEOS = 20;

function scVideosHtml() {
  const list = scState.videos || [];
  if (!list.length) return '<p class="panel__hint" style="margin:4px 0">Видео нет.</p>';
  return `<div id="scVideoRows">${list.map((u, i) => `
    <div data-vi="${i}" style="display:flex;gap:8px;align-items:center;margin:4px 0">
      <video src="${scEsc(u)}" muted loop playsinline preload="metadata" style="width:96px;height:64px;object-fit:cover;border-radius:6px;background:var(--bg)"></video>
      <span style="flex:1;min-width:0;word-break:break-all;font-size:12px">${scEsc(u)}</span>
      <button type="button" class="btn btn--ghost" data-sc="v-remove">Убрать</button>
    </div>`).join('')}</div>`;
}

function scVideosRefresh() {
  const el = document.getElementById('scVideos');
  if (el) el.innerHTML = scVideosHtml();
  const full = (scState.videos || []).length >= SC_MAX_VIDEOS;
  const add = document.querySelector('[data-sc="v-add"]');
  if (add) add.disabled = full;
  const addUrl = document.querySelector('[data-sc="v-add-url"]');
  if (addUrl) addUrl.disabled = full;
}

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
      ${scBannersBlockHtml('big', 'Рекламный баннер (большая карусель сверху)', isNew)}
      <div>Запасной баннер (показывается, если карусель выше пуста)<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${scThumb(c.bannerUrl)}
        <input type="file" id="scBannerFile" accept="image/jpeg,image/png,image/webp" />
        <input type="text" id="scBannerUrl" placeholder="или ссылка на картинку" value="${scEsc(c.bannerUrl)}" style="max-width:260px" /></div></div>
      ${scBannersBlockHtml('small', 'Несколько баннеров (маленькая карусель ниже)', isNew)}
      <div>Видео (до ${SC_MAX_VIDEOS}, MP4 или WEBM)
        <div id="scVideos">${scVideosHtml()}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <input type="file" id="scVideoAddFile" accept="video/mp4,video/webm" />
          <button type="button" class="btn btn--ghost" data-sc="v-add"${(scState.videos || []).length >= SC_MAX_VIDEOS ? ' disabled' : ''}>Добавить видео</button></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <input type="text" id="scVideoAddUrl" placeholder="или ссылка на видео (https://…)" style="max-width:320px;flex:1;min-width:200px" />
          <button type="button" class="btn btn--ghost" data-sc="v-add-url"${(scState.videos || []).length >= SC_MAX_VIDEOS ? ' disabled' : ''}>Добавить по ссылке</button></div>
        <p class="panel__hint" style="margin:4px 0 0">Файл до 3 МБ (ограничение Vercel на размер запроса) или ссылка — оба способа добавляют видео в список, не заменяя прежние; всего до ${SC_MAX_VIDEOS}. Изменения сохраняются кнопкой «${isNew ? 'Создать' : 'Сохранить'}».</p></div>
      <label>Ссылка на видео <input type="text" id="scVideoUrl" maxlength="2000" placeholder="https://…" value="${scEsc(c.videoUrl)}" /></label>
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
      <td>${scEsc(p.name)}<div class="panel__hint" style="margin:0">${scEsc(p.article || p.sku || p.id)}${p.price != null ? ` · ${scEsc(p.price)} ₸` : ''}${p.missing ? ' · нет в каталоге' : (!p.shopActive || p.shopArchived ? ' · не в продаже (покупателю не виден)' : '')}${p.showcaseOnly ? ' · только в витринах' : ''}</div></td>
      <td style="white-space:nowrap">
        <button type="button" class="btn btn--ghost" data-sc="${scope}-up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn btn--ghost" data-sc="${scope}-down" ${i === products.length - 1 ? 'disabled' : ''}>↓</button>
        ${scope === 'p' && !p.missing ? '<button type="button" class="btn btn--ghost" data-sc="p-edit">Редактировать</button>' : ''}
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
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <h3 style="margin:0 0 6px">Товары витрины (${c.products.length})</h3>
      <button type="button" class="btn btn--accent" data-sc="pnew">+ Новый товар</button>
    </div>
    <p class="panel__hint">Только товары, добавленные здесь. Один товар может быть в нескольких витринах; убрать товар из витрины не значит удалить его из каталога.</p>
    ${scSearchBox('products', '')}
    <div style="margin:8px 0">
      <label class="panel__hint" for="scBulkCodes" style="display:block;margin:0 0 4px">Массовая загрузка: артикулы (sku или артикул витрины) — по одному на строку или через запятую</label>
      <textarea id="scBulkCodes" rows="4" style="width:100%;max-width:520px;box-sizing:border-box" placeholder="1000123&#10;1000124, 1000125"></textarea>
      <div><button type="button" class="btn btn--accent" data-sc="pbulk">Добавить все</button></div>
    </div>
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
    banners: (scState.banners || []).slice(),
    bigBanners: (scState.bigBanners || []).slice(),
    bigBannerItems: (() => {
      const [lines, colors] = scBigExtras();
      return (scState.bigBanners || []).map((url, i) => {
        // пустые строки по краям сервер срежет вместе с их размерами; здесь шлём всё как есть
        const ls = lines[i].map((l) => ({ t: String(l.t || '').trim(), s: scClampSize(l.s) }));
        const filled = ls.some((l) => l.t);
        return {
          url,
          text: filled ? ls.map((l) => l.t).join('\n') : null,
          sizes: filled ? ls.map((l) => l.s) : [],
          textColor: colors[i] === 'black' ? 'black' : 'white',
        };
      });
    })(),
    videos: (scState.videos || []).slice(),
    videoUrl: v('scVideoUrl').trim() || null,
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
  const saveBtn = document.getElementById('scSave');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Сохраняю…'; }
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
    const b = document.getElementById('scSave');
    if (b) { b.disabled = false; b.textContent = scState.current ? 'Сохранить' : 'Создать'; }
  } finally {
    scState.busy = false;
  }
}

async function scOpen(id, okText) {
  try {
    scState.current = await api(`/shop-admin/showcases/${encodeURIComponent(id)}`);
    scState.banners = Array.isArray(scState.current.banners) ? scState.current.banners.slice() : [];
    scState.bigBanners = Array.isArray(scState.current.bigBanners) ? scState.current.bigBanners.slice() : [];
    scState.bigBannerLines = (Array.isArray(scState.current.bigBanners) ? scState.current.bigBanners : []).map((_, i) =>
      scLinesFrom((scState.current.bigBannerTexts || [])[i], (scState.current.bigBannerSizes || [])[i]));
    scState.bigBannerTextColors = Array.isArray(scState.current.bigBannerTextColors) ? scState.current.bigBannerTextColors.slice() : [];
    scBigExtras(); // старые витрины без текстов: выравниваем по числу баннеров
    scState.videos = Array.isArray(scState.current.videos) ? scState.current.videos.slice() : [];
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
    // Уже добавленные в этот список (витрину или подборку) помечаем и не даём добавить повторно.
    const cur = scState.current;
    const taken = new Set(((box.dataset.scope === 'items'
      ? ((cur && cur.collections.find((c) => c.id === box.dataset.cid)) || {}).products
      : cur && cur.products) || []).map((x) => x.id));
    out.innerHTML = rows.length
      ? rows.map((p) => `<div data-pid="${scEsc(p.id)}" style="display:flex;gap:8px;align-items:center;margin:4px 0">${scThumb(p.image)}<span style="flex:1">${scEsc(p.name)} <span class="panel__hint" style="margin:0">${scEsc(p.article || p.sku)}</span></span>${taken.has(p.id) ? '<span class="panel__hint" style="margin:0">уже добавлен</span>' : '<button type="button" class="btn btn--ghost" data-sc="padd">Добавить</button>'}</div>`).join('')
      : '<span class="panel__hint">Ничего не найдено</span>';
  } catch (err) {
    out.innerHTML = `<span style="color:var(--loss)">${scEsc(scErr(err))}</span>`;
  }
}

async function scHandleClick(e) {
  const btn = e.target.closest('[data-sc]');
  if (!btn || btn.disabled) return;
  // Пока предыдущее действие не закончилось, повторные клики игнорируются
  // (двойной клик не отправляет удаление/публикацию/добавление дважды).
  if (scState.busy) return;
  scState.busy = true;
  scRoot().setAttribute('aria-busy', 'true');
  const act = btn.dataset.sc;
  const base = scState.current ? `/shop-admin/showcases/${encodeURIComponent(scState.current.id)}` : '';
  const row = btn.closest('tr');
  const pid = row && row.dataset.pid;
  const colEl = btn.closest('.sc-collection');
  const cid = colEl && colEl.dataset.cid;
  const col = cid && scState.current && scState.current.collections.find((x) => x.id === cid);
  try {
    if (act === 'new') { scState.editingNew = true; scState.current = null; scState.banners = []; scState.bigBanners = []; scState.bigBannerLines = []; scState.bigBannerTextColors = []; scState.videos = []; scSetStatus('', ''); scRender(); }
    else if (act === 'reload') await loadShowcases();
    else if (act === 'v-add') {
      const fileEl = document.getElementById('scVideoAddFile');
      const list = scState.videos || (scState.videos = []);
      if (list.length >= SC_MAX_VIDEOS) { scSetStatus(`Не больше ${SC_MAX_VIDEOS} видео`, 'error'); return; }
      if (!fileEl.files[0]) { scSetStatus('Выберите файл MP4 или WEBM', 'error'); return; }
      scSetStatus('Загружаю видео…', '');
      const url = await uploadMyMarketFile(fileEl.files[0], { video: true });
      if (list.includes(url)) { scSetStatus('Такое видео уже добавлено', 'error'); return; }
      list.push(url);
      fileEl.value = '';
      scVideosRefresh();
      scSetStatus('Видео добавлено — нажмите «Сохранить», чтобы применить', '');
    } else if (act === 'v-add-url') {
      const urlEl = document.getElementById('scVideoAddUrl');
      const list = scState.videos || (scState.videos = []);
      const url = urlEl.value.trim();
      if (list.length >= SC_MAX_VIDEOS) { scSetStatus(`Не больше ${SC_MAX_VIDEOS} видео`, 'error'); return; }
      if (!url) { scSetStatus('Вставьте ссылку на видео', 'error'); return; }
      if (!/^https?:\/\/\S+$/i.test(url)) { scSetStatus('Ссылка должна начинаться с http:// или https://', 'error'); return; }
      if (list.includes(url)) { scSetStatus('Такое видео уже добавлено', 'error'); return; }
      list.push(url);
      urlEl.value = '';
      scVideosRefresh();
      scSetStatus('Видео добавлено — нажмите «Сохранить», чтобы применить', '');
    } else if (act === 'v-remove') {
      (scState.videos || []).splice(Number(btn.closest('[data-vi]').dataset.vi), 1);
      scVideosRefresh();
      scSetStatus('Видео убрано — нажмите «Сохранить», чтобы применить', '');
    }
    else if (act === 'bl-add' || act === 'bl-remove') {
      const i = Number(btn.closest('[data-bi]').dataset.bi);
      const [lines] = scBigExtras();
      if (act === 'bl-add') {
        if (lines[i].length >= 10) { scSetStatus('Не больше 10 строк на баннер', 'error'); return; }
        lines[i].push({ t: '', s: lines[i][lines[i].length - 1].s });
      } else if (lines[i].length > 1) lines[i].splice(Number(btn.closest('[data-li]').dataset.li), 1);
      scBannersRefresh('big');
    }
    else if (act === 'b-add') {
      const kind = btn.closest('[data-blist]').dataset.blist;
      const fileEl = document.getElementById(SC_LISTS[kind].file);
      const urlEl = document.getElementById(SC_LISTS[kind].url);
      const list = scList(kind);
      if (list.length >= SC_MAX_BANNERS) { scSetStatus(`Не больше ${SC_MAX_BANNERS} баннеров`, 'error'); return; }
      let url = urlEl.value.trim();
      if (fileEl.files[0]) {
        scSetStatus('Загружаю картинку…', '');
        url = await uploadMyMarketFile(fileEl.files[0]);
      }
      if (!url) { scSetStatus('Выберите файл или вставьте ссылку на картинку', 'error'); return; }
      if (!/^https?:\/\//i.test(url)) { scSetStatus('Ссылка должна начинаться с http:// или https://', 'error'); return; }
      if (list.includes(url)) { scSetStatus('Такой баннер уже добавлен', 'error'); return; }
      list.push(url);
      if (kind === 'big') { scBigExtras(); } // дополняет текст '' и цвет white для нового баннера
      fileEl.value = ''; urlEl.value = '';
      scBannersRefresh(kind);
      scSetStatus('Баннер добавлен — нажмите «Сохранить», чтобы применить', '');
    } else if (act === 'b-up' || act === 'b-down' || act === 'b-remove') {
      const i = Number(btn.closest('[data-bi]').dataset.bi);
      const kind = btn.closest('[data-blist]').dataset.blist;
      const list = scList(kind);
      const parallel = kind === 'big' ? scBigExtras() : [];
      if (act === 'b-remove') { list.splice(i, 1); parallel.forEach((a) => a.splice(i, 1)); }
      else {
        const j = i + (act === 'b-up' ? -1 : 1);
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        parallel.forEach((a) => { [a[i], a[j]] = [a[j], a[i]]; });
      }
      scBannersRefresh(kind);
      scSetStatus('Порядок изменён — нажмите «Сохранить», чтобы применить', '');
    }
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
    } else if (act === 'pnew') {
      // Та же карточка товара, что в разделе «Товары»; после сохранения товар попадёт и в каталог, и в эту витрину.
      const showcaseId = scState.current.id;
      openMyMarketNewProductCardForShowcase(showcaseId, (msg) => scOpen(showcaseId, msg));
    } else if (act === 'pbulk') {
      const area = document.getElementById('scBulkCodes');
      const codes = area.value.trim();
      if (!codes) { scSetStatus('Вставьте список артикулов', 'error'); return; }
      const r = await api(`${base}/products/bulk`, { method: 'POST', body: JSON.stringify({ codes }) });
      const left = [...r.notFound, ...r.ambiguous, ...r.overLimit];
      const parts = [`Добавлено: ${r.added.length}`];
      if (r.alreadyIn.length) parts.push(`уже были: ${r.alreadyIn.length}`);
      if (r.notFound.length) parts.push(`не найдено: ${r.notFound.join(', ')}`);
      if (r.ambiguous.length) parts.push(`неоднозначно (совпало с несколькими товарами): ${r.ambiguous.join(', ')}`);
      if (r.overLimit.length) parts.push(`не поместились в лимит: ${r.overLimit.join(', ')}`);
      await scOpen(scState.current.id, parts.join(' · '));
      // Невставшие артикулы остаются в поле — можно поправить и добавить ещё раз.
      const again = document.getElementById('scBulkCodes');
      if (again) again.value = left.join('\n');
    } else if (act === 'p-up' || act === 'p-down') {
      await scMove(scState.current.products, pid, act === 'p-up' ? -1 : 1, `${base}/products/order`, 'productIds');
    } else if (act === 'p-edit') {
      const showcaseId = scState.current.id;
      try {
        await openMyMarketProductCardForShowcase(pid, (msg) => scOpen(showcaseId, msg));
      } catch (err) {
        scSetStatus(`Не удалось открыть товар: ${scErr(err)}`, 'error');
      }
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
    // Порядок устарел (список изменили в другой вкладке): перечитываем и сообщаем.
    if (err && err.body && err.body.code === 'STALE_ORDER') {
      if (scState.current) await scOpen(scState.current.id, 'Список изменился — данные обновлены, повторите действие');
      else await loadShowcases();
      return;
    }
    scSetStatus(scErr(err), 'error');
  } finally {
    scState.busy = false;
    const r = scRoot();
    if (r) r.removeAttribute('aria-busy');
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
  const bbEdit = (e) => {
    const t = e.target;
    if (!t.classList || !(t.classList.contains('sc-bb-line') || t.classList.contains('sc-bb-size') || t.classList.contains('sc-bb-color'))) return false;
    const i = Number(t.closest('[data-bi]').dataset.bi);
    const [lines, colors] = scBigExtras();
    if (t.classList.contains('sc-bb-color')) { colors[i] = t.value === 'black' ? 'black' : 'white'; return true; }
    const j = Number(t.closest('[data-li]').dataset.li);
    if (t.classList.contains('sc-bb-line')) lines[i][j].t = t.value;
    else {
      lines[i][j].s = scClampSize(t.value);
      if (e.type === 'change') t.value = lines[i][j].s; // вне 1–100 или пусто → возвращаем допустимое
    }
    return true;
  };
  root.addEventListener('change', bbEdit);
  root.addEventListener('input', (e) => {
    if (bbEdit(e)) return;
    if (e.target.id !== 'scSearch') return;
    scState.q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(loadShowcases, 300);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'scVideoAddUrl') {
      e.preventDefault(); // Enter в поле ссылки = «Добавить по ссылке», а не сохранение формы
      const b = document.querySelector('[data-sc="v-add-url"]');
      if (b && !b.disabled) b.click();
      return;
    }
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('sc-bb-line')) {
      e.preventDefault(); // Enter = новая строка ниже, форму не отправляем
      const i = Number(e.target.closest('[data-bi]').dataset.bi);
      const j = Number(e.target.closest('[data-li]').dataset.li);
      const [lines] = scBigExtras();
      if (lines[i].length < 10) lines[i].splice(j + 1, 0, { t: '', s: lines[i][j].s });
      scBannersRefresh('big');
      const inp = document.querySelectorAll(`#scBigBanners [data-bi="${i}"] .sc-bb-line`)[Math.min(j + 1, lines[i].length - 1)];
      if (inp && inp.focus) inp.focus();
      return;
    }
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('sc-psearch')) {
      e.preventDefault();
      scPSearch(e.target.closest('[data-scope]'));
    }
  });
}
