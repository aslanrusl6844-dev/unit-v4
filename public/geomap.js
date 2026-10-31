/* Карта Казахстана в My Market → Аналитика: заказы и поисковые запросы по городам,
 * хаб в Алматы, маршруты и «машины в пути». Данные границ — public/kz-map-data.js (window.KZ_MAP).
 * Читает GET /api/shop-admin/analytics/geo (см. src/services/shopGeo.service.ts). */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var HUB = 'Алматы';
  var KM_PER_DAY = 600;      // ориентир: сколько км в сутки проезжает фура между городами
  var ROAD_FACTOR = 1.25;    // дорога длиннее прямой
  var MAX_K = 14;

  var state = { days: 30, mode: 'orders', data: null, selected: null, view: { k: 1, tx: 0, ty: 0 }, built: false };
  var els = {};

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function fmtInt(n) { return Number(n || 0).toLocaleString('ru-RU'); }
  function fmtMoney(n) { return fmtInt(Math.round(n || 0)) + ' ₸'; }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }

  function haversineKm(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function etaDays(city) {
    var c = window.KZ_MAP.cities[city], h = window.KZ_MAP.cities[HUB];
    if (!c || !h || city === HUB) return 0;
    return Math.max(1, Math.ceil(haversineKm(h, c) * ROAD_FACTOR / KM_PER_DAY));
  }
  /** Доля пути, которую машина уже проехала (оценка по времени с момента «забран/в пути»). */
  function truckProgress(c) {
    var days = etaDays(c.city);
    if (!days || !c.transitSince) return 0.05;
    var elapsed = (Date.now() - new Date(c.transitSince).getTime()) / 86400000;
    return Math.min(0.96, Math.max(0.04, elapsed / days));
  }

  function valueOf(c) { return state.mode === 'orders' ? c.orders : c.searches; }

  // ---------- Построение SVG ----------
  function build() {
    var M = window.KZ_MAP;
    var svg = els.svg;
    svg.setAttribute('viewBox', '0 0 ' + M.width + ' ' + M.height);
    svg.innerHTML = '';
    els.vp = el('g', { id: 'gmViewport' }, svg);
    els.regionsG = el('g', {}, els.vp);
    els.routesG = el('g', {}, els.vp);
    els.overlay = el('g', {}, svg); // маркеры, подписи и машины — не масштабируются вместе с картой
    els.regionPaths = {};
    M.regions.forEach(function (r) {
      var p = el('path', { d: r.d, class: 'gm-region', 'data-id': r.id }, els.regionsG);
      var t = el('title', {}, p); t.textContent = r.name;
      els.regionPaths[r.id] = p;
    });
    state.built = true;
    if (window.ResizeObserver) {
      var last = 0;
      new ResizeObserver(function () {
        var w = svg.getBoundingClientRect().width;
        if (Math.abs(w - last) > 1) { last = w; if (state.data) drawOverlay(); }
      }).observe(svg);
    }
  }

  function applyView() {
    var v = state.view, M = window.KZ_MAP;
    v.tx = Math.min(0, Math.max(M.width * (1 - v.k), v.tx));
    v.ty = Math.min(0, Math.max(M.height * (1 - v.k), v.ty));
    els.vp.setAttribute('transform', 'translate(' + v.tx.toFixed(2) + ',' + v.ty.toFixed(2) + ') scale(' + v.k.toFixed(3) + ')');
    drawOverlay();
  }

  function scr(city) {
    var c = window.KZ_MAP.cities[city], v = state.view;
    return { x: c.x * v.k + v.tx, y: c.y * v.k + v.ty };
  }

  function routePath(city) {
    var h = window.KZ_MAP.cities[HUB], c = window.KZ_MAP.cities[city];
    var mx = (h.x + c.x) / 2, my = (h.y + c.y) / 2;
    var dx = c.x - h.x, dy = c.y - h.y, len = Math.hypot(dx, dy) || 1;
    var off = len * 0.12;
    var cx = mx - (dy / len) * off, cy = my + (dx / len) * off;
    return 'M' + h.x + ',' + h.y + ' Q' + cx.toFixed(1) + ',' + cy.toFixed(1) + ' ' + c.x + ',' + c.y;
  }

  function colorRegions() {
    var M = window.KZ_MAP, byRegion = {};
    (state.data ? state.data.cities : []).forEach(function (c) {
      var r = M.cities[c.city] && M.cities[c.city].region;
      if (r) byRegion[r] = (byRegion[r] || 0) + valueOf(c);
    });
    var max = 0;
    for (var k in byRegion) max = Math.max(max, byRegion[k]);
    M.regions.forEach(function (r) {
      var v = byRegion[r.id] || 0, p = els.regionPaths[r.id];
      if (!v || !max) { p.style.fill = ''; p.style.fillOpacity = ''; p.classList.remove('gm-region--hot'); return; }
      p.classList.add('gm-region--hot');
      p.style.fillOpacity = (0.18 + 0.62 * Math.sqrt(v / max)).toFixed(2);
    });
  }

  function drawRoutes() {
    els.routesG.innerHTML = '';
    if (!state.data) return;
    state.data.cities.forEach(function (c) {
      if (c.city === HUB || (!c.orders && !c.inTransit)) return;
      var active = c.inTransit > 0;
      var p = el('path', { d: routePath(c.city), class: 'gm-route' + (active ? ' gm-route--active' : ''), 'data-city': c.city }, els.routesG);
      c._path = p;
    });
  }

  function radiusFor(v, max) {
    if (!v) return 4;
    return 8 + 10 * Math.sqrt(v / (max || 1));
  }

  function drawOverlay() {
    var g = els.overlay;
    g.innerHTML = '';
    if (!state.data) return;
    var M = window.KZ_MAP, v = state.view;
    var max = 0;
    state.data.cities.forEach(function (c) { max = Math.max(max, valueOf(c)); });
    // маркеры и подписи рисуем в экранных пикселях: размер не зависит от ширины карты (телефон, полный экран)
    var ctm = els.svg.getScreenCTM();
    var u = 1 / ((ctm && ctm.a) || 0.7);

    // машины — под маркерами
    state.data.cities.forEach(function (c) {
      if (!c.inTransit || c.city === HUB || !c._path) return;
      var len = c._path.getTotalLength();
      var pt = c._path.getPointAtLength(len * truckProgress(c));
      var x = pt.x * v.k + v.tx, y = pt.y * v.k + v.ty;
      var t = el('g', { class: 'gm-truck', transform: 'translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ') scale(' + u.toFixed(3) + ')' }, g);
      el('circle', { r: 13, class: 'gm-truck__bg' }, t);
      var tx = el('text', { class: 'gm-truck__ico', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, t);
      tx.textContent = '🚚';
      var title = el('title', {}, t);
      title.textContent = c.city + ': в пути ' + c.inTransit + ' зак., ориентировочно прибудет ' + fmtDate(new Date(new Date(c.transitSince).getTime() + etaDays(c.city) * 86400000).toISOString());
    });

    // города
    var sorted = state.data.cities.slice().sort(function (a, b) { return valueOf(a) - valueOf(b); });
    sorted.forEach(function (c) {
      var p = scr(c.city), val = valueOf(c), isHub = c.city === HUB;
      var grp = el('g', { class: 'gm-city' + (state.selected === c.city ? ' is-selected' : '') + (val ? '' : ' is-empty'), transform: 'translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ') scale(' + u.toFixed(3) + ')', 'data-city': c.city }, g);
      var r = radiusFor(val, max);
      if (isHub) {
        el('circle', { r: 20, class: 'gm-hub__pulse' }, grp);
        el('circle', { r: Math.max(r, 11), class: 'gm-hub' }, grp);
      } else {
        el('circle', { r: r, class: 'gm-dot' }, grp);
      }
      if (val) {
        var n = el('text', { class: 'gm-num', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, grp);
        n.textContent = val > 9999 ? Math.round(val / 1000) + 'k' : String(val);
      }
      if (state.mode === 'orders' && c.delivered > 0 && !c.inTransit && !isHub) {
        var ck = el('text', { class: 'gm-check', x: r * 0.7, y: -r * 0.7, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, grp);
        ck.textContent = '✓';
      }
      if (val || isHub || v.k >= 2.2) {
        // у правого края подпись уходит влево, чтобы не обрезалась
        var flip = p.x > M.width * 0.8;
        var lbl = el('text', { class: 'gm-label' + (isHub ? ' gm-label--hub' : ''), x: flip ? -(Math.max(r, 11) + 5) : Math.max(r, 11) + 5, y: isHub ? -8 : 1, 'text-anchor': flip ? 'end' : 'start', 'dominant-baseline': 'central' }, grp);
        lbl.textContent = isHub ? 'Алматы · хаб' : c.city;
      }
    });
  }

  // ---------- Правая колонка и таблица ----------
  function renderSide() {
    var d = state.data, box = els.list;
    els.sideTitle.textContent = state.mode === 'orders' ? 'Заказы по городам' : 'Поисковые запросы по городам';
    if (!d) { box.innerHTML = ''; return; }
    var rows = d.cities.filter(function (c) { return valueOf(c) > 0; }).sort(function (a, b) { return valueOf(b) - valueOf(a); });
    if (!rows.length) {
      box.innerHTML = '<p class="panel__hint">' + (state.mode === 'orders' ? 'За выбранный период заказов с городом из списка нет.' : 'За выбранный период поисковых запросов с городом нет.') + '</p>';
      return;
    }
    var max = valueOf(rows[0]);
    box.innerHTML = rows.map(function (c, i) {
      var sub = state.mode === 'orders'
        ? (c.topItems.length ? c.topItems.map(function (t) { return esc(t.name) + ' ×' + t.qty; }).join(', ') : '')
        : (c.topQueries.length ? c.topQueries.map(function (t) { return '«' + esc(t.query) + '» ' + t.count; }).join(', ') : '');
      return '<button type="button" class="gm-row' + (state.selected === c.city ? ' is-selected' : '') + '" data-city="' + esc(c.city) + '">' +
        '<span class="gm-row__rank">' + (i + 1) + '</span>' +
        '<span class="gm-row__main"><span class="gm-row__top"><b>' + esc(c.city) + '</b><span class="gm-row__val">' + fmtInt(valueOf(c)) +
        (state.mode === 'orders' ? ' <small>· ' + fmtMoney(c.revenue) + '</small>' : '') + '</span></span>' +
        '<span class="gm-row__bar"><i style="width:' + Math.max(4, Math.round(valueOf(c) / max * 100)) + '%"></i></span>' +
        (sub ? '<span class="gm-row__sub">' + (state.mode === 'orders' ? 'Чаще берут: ' : 'Ищут: ') + sub + '</span>' : '') +
        '</span></button>';
    }).join('');
    var extra = state.mode === 'orders' ? d.otherOrders : d.otherSearches;
    if (extra) box.insertAdjacentHTML('beforeend', '<p class="panel__hint" style="margin-top:8px">Без города из списка: ' + fmtInt(extra) + '</p>');
  }

  function renderShipments() {
    var d = state.data, tb = els.shipBody;
    if (!d) { tb.innerHTML = ''; return; }
    var rows = d.cities.filter(function (c) { return c.inTransit || c.paid || c.delivered; });
    rows.sort(function (a, b) { return (b.inTransit - a.inTransit) || (b.paid - a.paid) || (b.delivered - a.delivered); });
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="4" class="panel__hint">Пока нет заказов в работе и доставленных за период.</td></tr>'; return; }
    tb.innerHTML = rows.map(function (c) {
      var transit = '—';
      if (c.inTransit) {
        if (c.city === HUB) transit = '🚚 курьер по городу: ' + c.inTransit + ' зак.';
        else {
          var days = etaDays(c.city);
          var arr = new Date(new Date(c.transitSince).getTime() + days * 86400000).toISOString();
          transit = '🚚 1 машина · ' + c.inTransit + ' зак.<br><small>выехала ' + fmtDate(c.transitSince) + ', прибытие ~' + fmtDate(arr) + ' (' + days + ' дн. пути), проехала ~' + Math.round(truckProgress(c) * 100) + '%</small>';
        }
      }
      return '<tr class="gm-ship" data-city="' + esc(c.city) + '"><td><b>' + esc(c.city) + '</b></td><td>' + transit + '</td>' +
        '<td class="num">' + (c.paid ? fmtInt(c.paid) : '—') + '</td>' +
        '<td>' + (c.delivered ? '<span class="gm-ok">✓ ' + fmtInt(c.delivered) + '</span><br><small>последняя ' + fmtDate(c.lastDeliveredAt) + '</small>' : '—') + '</td></tr>';
    }).join('');
  }

  function renderTip() {
    var tip = els.tip;
    if (!state.selected || !state.data) { tip.hidden = true; return; }
    var c = state.data.cities.filter(function (x) { return x.city === state.selected; })[0];
    if (!c) { tip.hidden = true; return; }
    var lines = [];
    lines.push('<b>' + esc(c.city) + (c.city === HUB ? ' — хаб' : '') + '</b>');
    lines.push('Заказов: <b>' + fmtInt(c.orders) + '</b> · ' + fmtMoney(c.revenue));
    if (c.topItems.length) lines.push('Берут: ' + c.topItems.map(function (t) { return esc(t.name) + ' ×' + t.qty; }).join(', '));
    lines.push('Поисков: <b>' + fmtInt(c.searches) + '</b>' + (c.topQueries.length ? ' · ' + c.topQueries.map(function (t) { return '«' + esc(t.query) + '»'; }).join(', ') : ''));
    var st = [];
    if (c.paid) st.push('ждут отправки ' + c.paid);
    if (c.inTransit) st.push('в пути ' + c.inTransit);
    if (c.delivered) st.push('доставлено ' + c.delivered + ' ✓');
    if (st.length) lines.push(st.join(' · '));
    tip.innerHTML = lines.join('<br>') + '<button type="button" class="gm-tip__x" aria-label="Закрыть">×</button>';
    tip.hidden = false;
  }

  function renderAll() {
    colorRegions();
    drawRoutes();
    applyView();
    renderSide();
    renderShipments();
    renderTip();
  }

  // ---------- Масштаб и перемещение ----------
  function toViewBox(clientX, clientY) {
    var pt = els.svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    var m = els.svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
  }
  function zoomAt(px, py, factor) {
    var v = state.view, nk = Math.min(MAX_K, Math.max(1, v.k * factor));
    if (nk === v.k) return;
    var r = nk / v.k;
    v.tx = px - (px - v.tx) * r;
    v.ty = py - (py - v.ty) * r;
    v.k = nk;
    applyView();
  }
  function zoomToCity(name, k) {
    var c = window.KZ_MAP.cities[name], M = window.KZ_MAP;
    if (!c) return;
    k = k || 3;
    state.view.k = k;
    state.view.tx = M.width / 2 - c.x * k;
    state.view.ty = M.height / 2 - c.y * k;
    applyView();
  }
  function resetView() { state.view = { k: 1, tx: 0, ty: 0 }; applyView(); }

  function selectCity(name, opts) {
    state.selected = name;
    if (opts && opts.zoom) zoomToCity(name, Math.max(state.view.k, 3));
    else drawOverlay();
    renderSide();
    renderTip();
  }

  function wireOnce() {
    var svg = els.svg, pointers = {}, drag = null, pinch = null, moved = false;

    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = toViewBox(e.clientX, e.clientY);
      zoomAt(p.x, p.y, e.deltaY < 0 ? 1.25 : 0.8);
    }, { passive: false });

    svg.addEventListener('pointerdown', function (e) {
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      moved = false;
      var ids = Object.keys(pointers);
      if (ids.length === 1) drag = { x: e.clientX, y: e.clientY, tx: state.view.tx, ty: state.view.ty };
      if (ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: state.view.k };
        drag = null;
      }
    });
    svg.addEventListener('pointermove', function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length >= 2 && pinch) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        var mid = toViewBox((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomAt(mid.x, mid.y, (pinch.k * d / pinch.d) / state.view.k);
        moved = true;
      } else if (drag) {
        var s = toViewBox(drag.x, drag.y), c = toViewBox(e.clientX, e.clientY);
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) moved = true;
        if (moved) { state.view.tx = drag.tx + (c.x - s.x); state.view.ty = drag.ty + (c.y - s.y); applyView(); }
      }
    });
    function up(e) {
      delete pointers[e.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      if (!Object.keys(pointers).length) drag = null;
    }
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') up(e); });

    svg.addEventListener('click', function (e) {
      if (moved) return;
      var g = e.target.closest && e.target.closest('.gm-city');
      if (g) selectCity(g.getAttribute('data-city'));
      else if (state.selected) { state.selected = null; drawOverlay(); renderSide(); renderTip(); }
    });
    els.tip.addEventListener('click', function (e) {
      if (e.target.closest('.gm-tip__x')) { state.selected = null; drawOverlay(); renderSide(); renderTip(); }
    });

    $('gmZoomIn').addEventListener('click', function () { zoomAt(window.KZ_MAP.width / 2, window.KZ_MAP.height / 2, 1.5); });
    $('gmZoomOut').addEventListener('click', function () { zoomAt(window.KZ_MAP.width / 2, window.KZ_MAP.height / 2, 1 / 1.5); });
    $('gmReset').addEventListener('click', resetView);
    $('gmFull').addEventListener('click', function () {
      var box = $('gmMapBox');
      if (document.fullscreenElement) document.exitFullscreen();
      else if (box.requestFullscreen) box.requestFullscreen();
      else box.classList.toggle('gm-full'); // запасной вариант без Fullscreen API
    });

    els.list.addEventListener('click', function (e) {
      var row = e.target.closest('.gm-row');
      if (row) selectCity(row.getAttribute('data-city'), { zoom: true });
    });
    els.shipBody.addEventListener('click', function (e) {
      var tr = e.target.closest('.gm-ship');
      if (tr) { selectCity(tr.getAttribute('data-city'), { zoom: true }); $('gmMapBox').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    $('gmPeriod').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      document.querySelectorAll('#gmPeriod button').forEach(function (x) { x.classList.remove('is-active'); });
      b.classList.add('is-active');
      state.days = Number(b.dataset.days);
      load();
    });
    $('gmMode').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      document.querySelectorAll('#gmMode button').forEach(function (x) { x.classList.remove('is-active'); });
      b.classList.add('is-active');
      state.mode = b.dataset.mode;
      colorRegions(); drawOverlay(); renderSide(); renderTip();
    });
  }

  function load() {
    els.status.textContent = 'Загружаю…';
    return api('/shop-admin/analytics/geo?days=' + state.days).then(function (d) {
      state.data = d;
      els.status.textContent = '';
      renderAll();
    }).catch(function (err) {
      els.status.textContent = 'Не удалось загрузить карту: ' + (err && err.message ? err.message : err);
    });
  }

  window.loadMyMarketGeoMap = function () {
    if (!els.svg) {
      els.svg = $('gmSvg'); els.tip = $('gmTip'); els.list = $('gmList'); els.sideTitle = $('gmSideTitle');
      els.shipBody = $('gmShipBody'); els.status = $('gmStatus');
      if (!window.KZ_MAP) { els.status.textContent = 'Не загрузились границы карты (kz-map-data.js).'; return Promise.resolve(); }
      build();
      wireOnce();
    }
    return load();
  };
})();
