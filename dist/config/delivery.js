"use strict";
/**
 * Правила доставки для «Хода доставки» в приложении My Market.
 * Склад и хаб — Алматы. Внутри Алматы заказ привозит курьер на следующий день,
 * в другие города едет машина (несколько дней), потом заказ берёт местный курьер.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DELAY_NOTE = exports.DELAY_NOTICE_HOUR = exports.AUTO_SHIP_DELAY_HOURS = exports.DEFAULT_DELIVERY_DAYS = exports.DELIVERY_DAYS = exports.COURIER_WORKS_ON_SUNDAY = exports.EXPRESS_CUTOFF_HOUR = exports.ALMATY_UTC_OFFSET_HOURS = exports.HUB_CITY = void 0;
exports.HUB_CITY = 'Алматы';
/** Казахстан живёт по единому времени UTC+5 — на нём считаем «сегодня/завтра». */
exports.ALMATY_UTC_OFFSET_HOURS = 5;
/** Оплата ДО этого часа (по Алматы) → доставка завтра, ПОСЛЕ → послезавтра. */
exports.EXPRESS_CUTOFF_HOUR = 18;
/** Работают ли курьеры по воскресеньям. false → «завтра» в субботу превращается в понедельник. */
exports.COURIER_WORKS_ON_SUNDAY = true;
/** Дней в пути из Алматы до города (машина). Порядок городов — как в config/cities.ts. */
exports.DELIVERY_DAYS = {
    'Астана': 3, 'Шымкент': 3, 'Караганда': 3, 'Тараз': 3, 'Кызылорда': 3, 'Туркестан': 3, 'Талдыкорган': 3,
    'Актобе': 4, 'Павлодар': 4, 'Усть-Каменогорск': 4, 'Семей': 4, 'Атырау': 4, 'Костанай': 4,
    'Уральск': 4, 'Петропавловск': 4, 'Актау': 4, 'Кокшетау': 4, 'Экибастуз': 4, 'Жезказган': 4,
};
/** Город не из списка — считаем по самому длинному сроку. */
exports.DEFAULT_DELIVERY_DAYS = 4;
/** Через сколько часов после оплаты машина выезжает САМА (без кнопки в админке). Кнопка «Машина выехала» — ручной вариант, он главнее. */
exports.AUTO_SHIP_DELAY_HOURS = 8;
/** В последний день пути (и в день обещанной доставки по Алматы) после этого часа по Алматы, пока заказ не выдан, показываем «Курьер задерживается». */
exports.DELAY_NOTICE_HOUR = 18;
exports.DELAY_NOTE = 'Курьер задерживается';
//# sourceMappingURL=delivery.js.map