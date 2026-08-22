import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { kaspiClient } from '../integrations/kaspi.client';
import { MarketplaceName } from '../types';

export const ordersRouter = Router();

// Группы статусов Kaspi для вкладок-фильтров (как в кабинете Kaspi/Northline).
// Точные названия статусов в API Kaspi могут отличаться в отдельных случаях —
// если какой-то статус не попадает ни в одну вкладку, он просто не проходит фильтр.
const STATUS_GROUPS: Record<string, string[]> = {
  preorder: ['NEW', 'SIGN_REQUIRED', 'APPROVED_BY_BANK'],
  packing: ['ACCEPTED_BY_MERCHANT'],
  handover: ['ASSEMBLE'],
  delivering: ['COMPLETED'],
  cancelled: ['CANCELLED', 'CANCELLING', 'RETURNED'],
};

ordersRouter.get('/meta', async (_req, res) => {
  const [cities, deliveryTypes] = await Promise.all([
    prisma.order.findMany({ where: { city: { not: null } }, distinct: ['city'], select: { city: true }, orderBy: { city: 'asc' } }),
    prisma.order.findMany({ where: { deliveryType: { not: null } }, distinct: ['deliveryType'], select: { deliveryType: true }, orderBy: { deliveryType: 'asc' } }),
  ]);
  res.json({
    cities: cities.map((c) => c.city).filter(Boolean),
    deliveryTypes: deliveryTypes.map((d) => d.deliveryType).filter(Boolean),
  });
});

ordersRouter.get('/', async (req, res) => {
  const { from, to, marketplace, page = '1', pageSize = '50', city, deliveryType, statusGroup, search } = req.query as Record<string, string>;

  const where: any = {};
  if (from || to) {
    where.orderDate = {};
    if (from) where.orderDate.gte = new Date(from);
    if (to) where.orderDate.lte = new Date(to);
  }
  if (marketplace) where.marketplace = marketplace as MarketplaceName;
  if (city) where.city = city;
  if (deliveryType) where.deliveryType = deliveryType;
  if (statusGroup && STATUS_GROUPS[statusGroup]) where.status = { in: STATUS_GROUPS[statusGroup] };
  if (search) {
    where.OR = [
      { externalId: { contains: search } },
      { items: { some: { name: { contains: search } } } },
    ];
  }

  const take = Math.min(Number(pageSize) || 50, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: true },
      orderBy: { orderDate: 'desc' },
      take,
      skip,
    }),
    prisma.order.count({ where }),
  ]);

  res.json({ orders, total, page: Number(page) || 1, pageSize: take });
});

ordersRouter.get('/:id', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { items: { include: { product: true } } },
  });
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  res.json(order);
});

// Принять новый заказ Kaspi (перевести в статус ACCEPTED_BY_MERCHANT).
ordersRouter.post('/:id/accept', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.marketplace !== 'KASPI') return res.status(400).json({ error: 'Действие доступно только для заказов Kaspi' });
  if (!order.kaspiInternalId) return res.status(400).json({ error: 'У заказа нет внутреннего id Kaspi — пересинхронизируйте заказы' });

  try {
    await kaspiClient.acceptOrder(order.kaspiInternalId, order.externalId);
    const updated = await prisma.order.update({ where: { id: order.id }, data: { status: 'ACCEPTED_BY_MERCHANT' } });
    res.json({ ok: true, order: updated });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.response?.data ?? err?.message ?? err) });
  }
});

// Сформировать накладную для передачи заказа на Kaspi Доставку (статус ASSEMBLE).
// Печатную накладную нужно будет скачать в личном кабинете Kaspi — API её не отдаёт,
// этот запрос только переводит заказ в статус, при котором накладная там появляется.
ordersRouter.post('/:id/waybill', async (req, res) => {
  const schema = z.object({ numberOfSpace: z.number().int().positive().default(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.marketplace !== 'KASPI') return res.status(400).json({ error: 'Действие доступно только для заказов Kaspi' });
  if (!order.kaspiInternalId) return res.status(400).json({ error: 'У заказа нет внутреннего id Kaspi — пересинхронизируйте заказы' });

  try {
    await kaspiClient.formWaybill(order.kaspiInternalId, parsed.data.numberOfSpace);
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'ASSEMBLE', numberOfSpace: parsed.data.numberOfSpace, waybillGeneratedAt: new Date() },
    });
    res.json({ ok: true, order: updated });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.response?.data ?? err?.message ?? err) });
  }
});

/**
 * Массово перевести несколько заказов в статус ASSEMBLE (сформировать
 * накладные) за один запрос — вместо клика по каждому заказу отдельно.
 * Возвращает список успехов/ошибок по каждому id, чтобы одна плохая
 * позиция не мешала обработать остальные.
 */
ordersRouter.post('/bulk-waybill', async (req, res) => {
  const schema = z.object({ ids: z.array(z.string()).min(1).max(200), numberOfSpace: z.number().int().positive().default(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  for (const id of parsed.data.ids) {
    try {
      const order = await prisma.order.findUnique({ where: { id } });
      if (!order) throw new Error('Заказ не найден');
      if (order.marketplace !== 'KASPI') throw new Error('Только заказы Kaspi');
      if (!order.kaspiInternalId) throw new Error('Нет внутреннего id Kaspi — пересинхронизируйте');

      await kaspiClient.formWaybill(order.kaspiInternalId, parsed.data.numberOfSpace);
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'ASSEMBLE', numberOfSpace: parsed.data.numberOfSpace, waybillGeneratedAt: new Date() },
      });
      results.push({ id, ok: true });
    } catch (err: any) {
      results.push({ id, ok: false, error: String(err?.response?.data ?? err?.message ?? err) });
    }
  }

  res.json({ ok: true, results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
});

/**
 * Печатная страница накладных — HTML, отформатированный для печати
 * (браузер сам предлагает "Сохранить как PDF" через Ctrl+P). Мы намеренно
 * НЕ генерируем настоящий PDF-файл на сервере: у Kaspi нет API, отдающего
 * готовый бланк накладной, а добавлять в проект ещё одну библиотеку ради
 * этого — лишний риск сломать сборку на Vercel. Печать через браузер даёт
 * тот же результат для реальной работы (накладная с составом заказа),
 * без единой новой зависимости.
 */
ordersRouter.get('/print/waybills', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.status(400).send('Не указаны заказы (параметр ids)');

  const orders = await prisma.order.findMany({
    where: { id: { in: ids } },
    include: { items: true },
    orderBy: { orderDate: 'asc' },
  });

  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

  const pages = orders
    .map((o) => {
      const rows = o.items
        .map(
          (i) => `<tr><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.externalSku)}</td><td class="num">${i.quantity}</td><td class="num">${Math.round(i.price)} ₸</td><td class="num">${Math.round(i.price * i.quantity)} ₸</td></tr>`,
        )
        .join('');
      return `
        <section class="waybill">
          <header>
            <h1>Накладная — заказ №${escapeHtml(o.externalId)}</h1>
            <div class="meta">
              <span>Дата заказа: ${new Date(o.orderDate).toLocaleDateString('ru-RU')}</span>
              <span>Город: ${escapeHtml(o.city ?? '—')}</span>
              <span>Доставка: ${escapeHtml(o.deliveryType ?? 'Kaspi Доставка')}</span>
              <span>Мест: ${o.numberOfSpace ?? 1}</span>
            </div>
          </header>
          <table>
            <thead><tr><th>Товар</th><th>Артикул</th><th class="num">Кол-во</th><th class="num">Цена</th><th class="num">Сумма</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="total">Итого: ${Math.round(o.totalRevenue)} ₸</div>
        </section>
      `;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Накладные</title>
<style>
  body { font-family: Arial, sans-serif; color: #14171F; margin: 0; padding: 20px; }
  .waybill { padding: 24px; border: 1px solid #ccc; border-radius: 8px; margin-bottom: 24px; page-break-after: always; }
  .waybill h1 { font-size: 18px; margin: 0 0 10px; }
  .meta { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: #555; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  .num { text-align: right; }
  .total { text-align: right; font-weight: 700; margin-top: 10px; font-size: 15px; }
  @media print { .waybill { border: none; } .no-print { display: none; } }
</style></head>
<body>
  <div class="no-print" style="margin-bottom:16px">
    <button onclick="window.print()" style="padding:8px 16px;font-size:14px;cursor:pointer">🖨 Печать / Сохранить как PDF</button>
  </div>
  ${pages || '<p>Заказы не найдены.</p>'}
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
