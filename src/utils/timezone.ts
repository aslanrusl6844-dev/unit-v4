import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * ВСЕ фильтры по датам (Обзор, Заказы, Финансы, синхронизация) должны
 * считать "сегодня"/"начало дня"/"конец дня" по часовому поясу Алматы
 * (UTC+5), а не по часовому поясу сервера. На Vercel сервер работает в
 * UTC — без этого файла "сегодня" на сервере наступает на 5 часов позже,
 * чем в Алматы, из-за чего заказы конца дня по Алматы (после ~19:00 UTC)
 * попадали не в тот календарный день при фильтрации.
 */
export const ALMATY_TZ = 'Asia/Almaty';

/** Строка "YYYY-MM-DD" (календарная дата в Алматы) -> Date, соответствующий
 *  началу этого дня (00:00:00) ИМЕННО В АЛМАТЫ, переведённый в правильный UTC-момент. */
export function almatyStartOfDay(dateStr: string): Date {
  return dayjs.tz(dateStr, ALMATY_TZ).startOf('day').toDate();
}

/** То же самое, но конец дня (23:59:59.999) в Алматы. */
export function almatyEndOfDay(dateStr: string): Date {
  return dayjs.tz(dateStr, ALMATY_TZ).endOf('day').toDate();
}

/** Текущий момент времени в Алматы — используется вместо "голого" new Date()
 *  везде, где нужно определить "какой сегодня день" (например, синхронизация
 *  за последние N дней). */
export function almatyNow(): dayjs.Dayjs {
  return dayjs().tz(ALMATY_TZ);
}
