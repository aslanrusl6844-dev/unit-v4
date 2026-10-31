import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDelivery, expressPromiseDate, ruDate, type DeliveryOrderInput } from '../src/services/deliveryProgress';

// Время Алматы = UTC+5. 2026-10-30 14:12 по Алматы = 09:12 UTC.
const d = (iso: string) => new Date(iso);
function order(p: Partial<DeliveryOrderInput>): DeliveryOrderInput {
  return {
    status: 'paid', city: 'Астана', createdAt: d('2026-10-30T09:00:00Z'), paidAt: d('2026-10-30T09:12:00Z'),
    updatedAt: d('2026-10-30T09:12:00Z'), deliveredAt: null, shippedAt: null, arrivedAt: null, ...p,
  };
}

test('до оплаты хода доставки нет', () => {
  assert.equal(buildDelivery(order({ status: 'pending_payment' })), null);
});

test('отменённый — короткая карточка без шагов', () => {
  const r = buildDelivery(order({ status: 'cancelled' }))!;
  assert.equal(r.kind, 'cancelled');
  assert.equal(r.steps.length, 0);
});

test('Алматы: оплата до 18:00 → завтра, после → послезавтра', () => {
  assert.equal(ruDate(expressPromiseDate(d('2026-10-30T09:12:00Z'))), '31 октября');  // 14:12 Алматы
  assert.equal(ruDate(expressPromiseDate(d('2026-10-30T14:00:00Z'))), '1 ноября');    // 19:00 Алматы
});

test('Алматы: ракета, 4 шага, сегодняшний день → «Доставим завтра»', () => {
  const r = buildDelivery(order({ city: 'Алматы' }), d('2026-10-30T10:00:00Z'))!;
  assert.equal(r.kind, 'express');
  assert.equal(r.title, 'Доставим завтра');
  assert.equal(r.icon, 'rocket');
  assert.equal(r.steps.length, 4);
  assert.equal(r.steps[1].state, 'now');
  assert.equal(r.steps[1].icon, 'rocket');
  assert.deepEqual(r.progress, { total: 4, done: 1, current: 1 });
});

test('Алматы: курьер забрал → шаг «Курьер привезёт вам» текущий; выдан → всё зелёное', () => {
  const picked = buildDelivery(order({ city: 'Алматы', status: 'picked' }), d('2026-10-30T10:00:00Z'))!;
  assert.equal(picked.steps[2].state, 'now');
  const done = buildDelivery(order({ city: 'Алматы', status: 'delivered', deliveredAt: d('2026-10-31T10:20:00Z') }))!;
  assert.equal(done.title, 'Получен');
  assert.ok(done.steps.every((s) => s.state === 'done' && s.icon === 'check'));
});

test('другой город, машина ещё не выехала', () => {
  const r = buildDelivery(order({}), d('2026-10-30T10:00:00Z'))!;
  assert.equal(r.kind, 'intercity');
  assert.equal(r.title, 'Готовим к отправке');
  assert.equal(r.steps[1].state, 'now');
});

test('другой город: День 2 из 3 → грузовик на «День 2», день 3 — «прибытие ~»', () => {
  const shipped = d('2026-10-30T22:30:00Z'); // 31 окт 03:30 по Алматы
  const r = buildDelivery(order({ shippedAt: shipped }), d('2026-11-01T05:00:00Z'))!; // 1 ноя по Алматы
  assert.equal(r.title, 'День 2 из 3 · в пути');
  assert.match(r.subtitle, /прибытие ~ 2 ноября/);
  const now = r.steps.find((s) => s.state === 'now')!;
  assert.equal(now.title, 'День 2 · в пути');
  assert.equal(now.icon, 'truck');
  assert.equal(r.steps.filter((s) => s.title.startsWith('День')).length, 3);
  assert.equal(r.progress.total, r.steps.length);
});

test('дальний город — 4 дня; день не выходит за предел', () => {
  const r = buildDelivery(order({ city: 'Петропавловск', shippedAt: d('2026-10-20T00:00:00Z') }), d('2026-11-05T00:00:00Z'))!;
  assert.equal(r.title, 'День 4 из 4 · в пути');
});

test('«Машина прибыла» → шаг курьера текущий; курьер забрал без отметки — тоже считается прибытием', () => {
  const arrived = buildDelivery(order({ shippedAt: d('2026-10-30T22:30:00Z'), arrivedAt: d('2026-11-02T06:05:00Z') }))!;
  assert.equal(arrived.steps.find((s) => s.state === 'now')!.title, 'Курьер привезёт вам');
  const implicit = buildDelivery(order({ status: 'in_transit' }))!;
  assert.equal(implicit.steps.find((s) => s.state === 'now')!.title, 'Курьер привезёт вам');
});

test('выдан в другом городе: все шаги зелёные', () => {
  const r = buildDelivery(order({ status: 'delivered', shippedAt: d('2026-10-30T22:30:00Z'), arrivedAt: d('2026-11-02T06:05:00Z'), deliveredAt: d('2026-11-02T10:20:00Z') }))!;
  assert.equal(r.title, 'Получен');
  assert.equal(r.steps.length, 6);
  assert.ok(r.steps.every((s) => s.state === 'done'));
});

test('город не из списка и алиас', () => {
  assert.equal(buildDelivery(order({ city: 'Неизвестноград' }))!.kind, 'intercity');
  assert.equal(buildDelivery(order({ city: 'Нур-Султан' }))!.subtitle.includes('Астана'), true);
  assert.equal(buildDelivery(order({ city: 'алма-ата' }))!.kind, 'express');
});

test('авто: через 8 часов после оплаты машина выезжает сама, без кнопки в админке', () => {
  // оплата 30 окт 14:12 по Алматы → выезд 22:12
  const before = buildDelivery(order({}), d('2026-10-30T16:00:00Z'))!; // 21:00 Алматы
  assert.equal(before.title, 'Готовим к отправке');
  const after = buildDelivery(order({}), d('2026-10-30T17:30:00Z'))!; // 22:30 Алматы
  assert.equal(after.title, 'День 1 из 3 · в пути');
  assert.equal(after.note, null);
});

test('авто: дни переключаются сами каждые сутки по календарю Алматы', () => {
  assert.equal(buildDelivery(order({}), d('2026-10-31T10:00:00Z'))!.title, 'День 2 из 3 · в пути'); // 31 окт
  assert.equal(buildDelivery(order({}), d('2026-11-01T05:00:00Z'))!.title, 'День 3 из 3 · в пути'); // 1 ноя утро
});

test('«Курьер задерживается»: последний день после 18:00 и дальше, пока заказ не выдан', () => {
  const morning = buildDelivery(order({}), d('2026-11-01T05:00:00Z'))!;   // день 3, 10:00
  assert.equal(morning.note, null);
  const evening = buildDelivery(order({}), d('2026-11-01T14:00:00Z'))!;   // день 3, 19:00
  assert.equal(evening.note, 'Курьер задерживается');
  const nextDay = buildDelivery(order({}), d('2026-11-02T05:00:00Z'))!;   // день 4
  assert.equal(nextDay.title, 'День 3 из 3 · в пути');
  assert.equal(nextDay.note, 'Курьер задерживается');
});

test('подпись пропадает, когда курьер взял заказ или заказ выдан', () => {
  const picked = buildDelivery(order({ status: 'in_transit' }), d('2026-11-02T05:00:00Z'))!;
  assert.equal(picked.note, null);
  const done = buildDelivery(order({ status: 'delivered', deliveredAt: d('2026-11-02T10:20:00Z') }), d('2026-11-03T05:00:00Z'))!;
  assert.equal(done.note, null);
});

test('Алматы: после обещанного дня 18:00 — «Курьер задерживается»', () => {
  const ok = buildDelivery(order({ city: 'Алматы' }), d('2026-10-31T05:00:00Z'))!;     // 31 окт 10:00 — доставка завтра сегодня
  assert.equal(ok.note, null);
  const late = buildDelivery(order({ city: 'Алматы' }), d('2026-10-31T14:00:00Z'))!;   // 31 окт 19:00
  assert.equal(late.note, 'Курьер задерживается');
});

test('ручная кнопка «Машина выехала» главнее авто-выезда', () => {
  const r = buildDelivery(order({ shippedAt: d('2026-10-31T01:00:00Z') }), d('2026-10-31T10:00:00Z'))!; // выехала 31 окт 06:00
  assert.equal(r.title, 'День 1 из 3 · в пути');
});
