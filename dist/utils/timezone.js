"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALMATY_TZ = void 0;
exports.almatyStartOfDay = almatyStartOfDay;
exports.almatyEndOfDay = almatyEndOfDay;
exports.almatyNow = almatyNow;
const dayjs_1 = __importDefault(require("dayjs"));
const utc_1 = __importDefault(require("dayjs/plugin/utc"));
const timezone_1 = __importDefault(require("dayjs/plugin/timezone"));
dayjs_1.default.extend(utc_1.default);
dayjs_1.default.extend(timezone_1.default);
/**
 * ВСЕ фильтры по датам (Обзор, Заказы, Финансы, синхронизация) должны
 * считать "сегодня"/"начало дня"/"конец дня" по часовому поясу Алматы
 * (UTC+5), а не по часовому поясу сервера. На Vercel сервер работает в
 * UTC — без этого файла "сегодня" на сервере наступает на 5 часов позже,
 * чем в Алматы, из-за чего заказы конца дня по Алматы (после ~19:00 UTC)
 * попадали не в тот календарный день при фильтрации.
 */
exports.ALMATY_TZ = 'Asia/Almaty';
/** Строка "YYYY-MM-DD" (календарная дата в Алматы) -> Date, соответствующий
 *  началу этого дня (00:00:00) ИМЕННО В АЛМАТЫ, переведённый в правильный UTC-момент. */
function almatyStartOfDay(dateStr) {
    return dayjs_1.default.tz(dateStr, exports.ALMATY_TZ).startOf('day').toDate();
}
/** То же самое, но конец дня (23:59:59.999) в Алматы. */
function almatyEndOfDay(dateStr) {
    return dayjs_1.default.tz(dateStr, exports.ALMATY_TZ).endOf('day').toDate();
}
/** Текущий момент времени в Алматы — используется вместо "голого" new Date()
 *  везде, где нужно определить "какой сегодня день" (например, синхронизация
 *  за последние N дней). */
function almatyNow() {
    return (0, dayjs_1.default)().tz(exports.ALMATY_TZ);
}
//# sourceMappingURL=timezone.js.map