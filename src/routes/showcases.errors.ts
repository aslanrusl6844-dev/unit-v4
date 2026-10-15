/**
 * Понятные HTTP-ответы на типичные ошибки Prisma для витрин (вместо общего 500).
 * Коды Prisma: P2025 — запись не найдена (её успели удалить), P2002 — нарушена
 * уникальность, P2021/P2022 — таблицы/колонки ещё нет в базе (миграция витрин
 * не применена). Прочие ошибки возвращают null — вызывающий код отдаёт 500.
 */
export function mapDbError(err: any): { status: number; body: { error: string; code: string } } | null {
  switch (err?.code) {
    case 'P2025':
      return { status: 404, body: { error: 'Запись не найдена (возможно, её уже удалили)', code: 'NOT_FOUND' } };
    case 'P2002':
      return { status: 409, body: { error: 'Такая запись уже есть', code: 'DUPLICATE' } };
    case 'P2021':
    case 'P2022':
      return {
        status: 503,
        body: { error: 'Таблицы витрин ещё не созданы в базе данных (не применена миграция)', code: 'SHOWCASES_NOT_MIGRATED' },
      };
    default:
      return null;
  }
}
