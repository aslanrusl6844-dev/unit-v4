import { Router } from 'express';
import { z } from 'zod';
import JSZip from 'jszip';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { almatyStartOfDay, almatyEndOfDay, almatyNow, ALMATY_TZ } from '../utils/timezone';
import dayjs from 'dayjs';
// Только типы — при сборке стираются и в рантайме ничего не подключают.
import type { WholesalerWaybillMarketplace, WholesalerWaybillItem, WholesalerWaybillInput } from '../services/wholesalerWaybill.service';

/**
 * Генератор накладных (pdfkit, bwip-js, шрифты) подключается ЛЕНИВО — только в
 * момент скачивания накладной. Список оптовиков, добавление и перенос товара
 * от него не зависят: даже если файл сервиса или его библиотеки недоступны,
 * функция стартует, а ошибка будет только у самой накладной (её ловят
 * обработчики ниже и отдают понятное сообщение).
 */
async function generateWholesalerWaybillPdf(input: WholesalerWaybillInput): Promise<Buffer> {
  const mod = await import('../services/wholesalerWaybill.service');
  return mod.generateWholesalerWaybillPdf(input);
}

/**
 * Оптовики раздела «Товары» (Kaspi / Ozon / WB): полки товаров по оптовикам.
 * Модель Product, синхронизация и расчёт комиссии/логистики/налога НЕ
 * затрагиваются: привязка «товар -> оптовик» живёт в своей таблице
 * WholesalerProduct, а товар без записи в ней — на полке «Без оптовика».
 */
export const wholesalersRouter = Router();

const ALL_MARKETPLACES: WholesalerWaybillMarketplace[] = ['KASPI', 'OZON', 'WB'];
const MARKETPLACE_LABEL: Record<WholesalerWaybillMarketplace, string> = { KASPI: 'Kaspi', OZON: 'Ozon', WB: 'Wildberries' };
/** Не больше стольких накладных в одном ZIP — иначе serverless-функция не уложится по времени. */
const WHOLESALER_ZIP_LIMIT = 150;

// ---------------------------------------------------------------------
// Полки: список оптовиков, привязки, добавление, перенос товара
// ---------------------------------------------------------------------

/** Оптовики (в порядке добавления) и привязки товаров: { [productId]: wholesalerId }. */
wholesalersRouter.get('/', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const [wholesalers, links] = await Promise.all([
      prisma.wholesaler.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.wholesalerProduct.findMany({ select: { productId: true, wholesalerId: true } }),
    ]);
    const assignments: Record<string, string> = {};
    for (const l of links as Array<{ productId: string; wholesalerId: string }>) assignments[l.productId] = l.wholesalerId;
    res.json({ wholesalers, assignments });
  } catch (err: any) {
    logger.error({ err }, '[Wholesalers] GET / упал');
    res.status(500).json({ error: 'Не удалось получить оптовиков', details: String(err?.message ?? err) });
  }
});

/** Телефон необязателен: пустая строка = «нет телефона» (хранится как null). */
const phoneField = z.string().trim().max(40).optional().nullable().transform((v) => (v ? v : null));

const createSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  phone: phoneField,
});

/** Добавить оптовика — имя и фамилию вписывает сам пользователь. Количество не ограничено. */
wholesalersRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Укажите имя и фамилию оптовика', details: parsed.error.flatten() });
  try {
    const wholesaler = await prisma.wholesaler.create({ data: parsed.data });
    res.status(201).json(wholesaler);
  } catch (err: any) {
    logger.error({ err }, '[Wholesalers] POST / упал');
    res.status(500).json({ error: 'Не удалось добавить оптовика', details: String(err?.message ?? err) });
  }
});

const updateSchema = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  phone: phoneField,
});

/**
 * Переименовать оптовика / сменить телефон. Меняются только переданные поля;
 * пустые имя или фамилия не принимаются. Товары полки привязаны к id оптовика,
 * поэтому ни привязки, ни продажи, ни накладные при этом не сбрасываются.
 */
wholesalersRouter.patch('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Имя и фамилия не могут быть пустыми', details: parsed.error.flatten() });
  const data: { firstName?: string; lastName?: string; phone?: string | null } = {};
  if (parsed.data.firstName !== undefined) data.firstName = parsed.data.firstName;
  if (parsed.data.lastName !== undefined) data.lastName = parsed.data.lastName;
  // phone меняем, только если поле реально прислано (в т.ч. пустое — это очистка телефона).
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'phone')) data.phone = parsed.data.phone ?? null;
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Нечего менять' });
  try {
    const exists = await prisma.wholesaler.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Оптовик не найден' });
    const wholesaler = await prisma.wholesaler.update({ where: { id: req.params.id }, data });
    res.json(wholesaler);
  } catch (err: any) {
    logger.error({ err }, '[Wholesalers] PATCH /:id упал');
    res.status(500).json({ error: 'Не удалось сохранить оптовика', details: String(err?.message ?? err) });
  }
});

const moveSchema = z.object({
  productId: z.string().min(1),
  /** id оптовика; null — вернуть товар на полку «Без оптовика». */
  wholesalerId: z.string().min(1).nullable(),
});

/**
 * Переместить товар на полку другого оптовика. Один товар — одна полка:
 * запись перезаписывается, у прежнего оптовика товар пропадает сам. Сам товар
 * (себестоимость, цены, комиссия, логистика, налог) не меняется — меняется
 * только эта привязка.
 */
wholesalersRouter.post('/move', async (req, res) => {
  const parsed = moveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const { productId, wholesalerId } = parsed.data;
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) return res.status(404).json({ error: 'Товар не найден' });

    if (wholesalerId === null) {
      await prisma.wholesalerProduct.deleteMany({ where: { productId } });
      return res.json({ productId, wholesalerId: null });
    }
    const wholesaler = await prisma.wholesaler.findUnique({ where: { id: wholesalerId }, select: { id: true } });
    if (!wholesaler) return res.status(404).json({ error: 'Оптовик не найден' });
    await prisma.wholesalerProduct.upsert({
      where: { productId },
      update: { wholesalerId, assignedAt: new Date() },
      create: { productId, wholesalerId },
    });
    res.json({ productId, wholesalerId });
  } catch (err: any) {
    logger.error({ err }, '[Wholesalers] POST /move упал');
    res.status(500).json({ error: 'Не удалось переместить товар', details: String(err?.message ?? err) });
  }
});

// ---------------------------------------------------------------------
// Накладные: по одной PDF и пачкой ZIP
// ---------------------------------------------------------------------

/** Заказ отменён/возвращён (статусы у площадок — свободный текст) — накладную на него не делаем. */
function isShippableStatus(status: string | null | undefined): boolean {
  return !/cancel|return/i.test(status ?? '');
}

function parseMarketplaces(raw: unknown): WholesalerWaybillMarketplace[] | null {
  if (raw === undefined || raw === '' || raw === null) return ALL_MARKETPLACES; // «Всё вместе»
  const v = String(raw).toUpperCase();
  return (ALL_MARKETPLACES as string[]).includes(v) ? [v as WholesalerWaybillMarketplace] : null;
}

function parseRange(query: Record<string, unknown>): { from: Date; to: Date } {
  const to = typeof query.to === 'string' && query.to ? almatyEndOfDay(query.to) : almatyNow().endOf('day').toDate();
  const from = typeof query.from === 'string' && query.from
    ? almatyStartOfDay(query.from)
    : dayjs(to).tz(ALMATY_TZ).subtract(30, 'day').startOf('day').toDate();
  return { from, to };
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'x';

function articleFor(marketplace: WholesalerWaybillMarketplace, product: any, externalSku: string): string | null {
  const own = marketplace === 'KASPI' ? product?.kaspiSku : marketplace === 'OZON' ? product?.ozonOfferId : product?.wbArticle;
  return own ?? externalSku ?? null;
}

interface WaybillJob {
  wholesalerName: string;
  marketplace: WholesalerWaybillMarketplace;
  orderNumber: string;
  orderDate: Date;
  city: string | null;
  items: WholesalerWaybillItem[];
}

const ORDER_INCLUDE = {
  items: { include: { product: { select: { sku: true, kaspiSku: true, ozonOfferId: true, wbArticle: true } } } },
};

/** Накладные одной полки: заказы за период по товарам этого оптовика, по каждой выбранной площадке отдельно. */
async function collectJobs(
  wholesaler: { id: string; firstName: string; lastName: string },
  marketplaces: WholesalerWaybillMarketplace[],
  from: Date,
  to: Date,
): Promise<WaybillJob[]> {
  const links: Array<{ productId: string }> = await prisma.wholesalerProduct.findMany({
    where: { wholesalerId: wholesaler.id },
    select: { productId: true },
  });
  const productIds = links.map((l) => l.productId);
  if (!productIds.length) return [];
  const idSet = new Set(productIds);
  const wholesalerName = `${wholesaler.firstName} ${wholesaler.lastName}`;
  const jobs: WaybillJob[] = [];
  for (const marketplace of marketplaces) {
    const orders: any[] = await prisma.order.findMany({
      where: { marketplace, orderDate: { gte: from, lte: to }, items: { some: { productId: { in: productIds } } } },
      orderBy: { orderDate: 'desc' },
      include: ORDER_INCLUDE,
    });
    for (const order of orders) {
      if (!isShippableStatus(order.status)) continue;
      // Только товары ЭТОГО оптовика — чужие позиции того же заказа в его накладную не попадают.
      const items: WholesalerWaybillItem[] = order.items
        .filter((i: any) => i.productId && idSet.has(i.productId))
        .map((i: any) => ({
          sku: i.product?.sku ?? i.externalSku,
          article: articleFor(marketplace, i.product, i.externalSku),
          name: i.name,
          quantity: i.quantity,
        }));
      if (!items.length) continue;
      jobs.push({ wholesalerName, marketplace, orderNumber: order.externalId, orderDate: order.orderDate, city: order.city ?? null, items });
    }
  }
  return jobs;
}

async function sendZip(
  res: any,
  jobs: WaybillJob[],
  opts: { multipleWholesalers: boolean; multipleMarketplaces: boolean; fileName: string },
) {
  const total = jobs.length;
  const batch = jobs.slice(0, WHOLESALER_ZIP_LIMIT);
  const zip = new JSZip();
  let included = 0;
  let failed = 0;
  for (const job of batch) {
    try {
      const pdf = await generateWholesalerWaybillPdf(job);
      const parts: string[] = [];
      if (opts.multipleWholesalers) parts.push(safeName(job.wholesalerName));
      // Kaspi / Ozon / WB в одном ZIP не смешиваются: при «Всё вместе» — отдельные папки.
      if (opts.multipleMarketplaces) parts.push(MARKETPLACE_LABEL[job.marketplace]);
      parts.push(`${MARKETPLACE_LABEL[job.marketplace]}_${safeName(job.orderNumber)}.pdf`);
      zip.file(parts.join('/'), pdf);
      included += 1;
    } catch (err: any) {
      failed += 1;
      logger.warn({ err: String(err?.message ?? err), orderNumber: job.orderNumber }, '[Wholesalers] накладная не собралась — пропущена в ZIP');
    }
  }
  if (!included) {
    return res.status(500).json({ error: 'Ни одна накладная не собралась' });
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="waybills.zip"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`);
  res.setHeader('X-Waybills-Total', String(total));
  res.setHeader('X-Waybills-Included', String(included));
  res.setHeader('X-Waybills-Failed', String(failed));
  res.setHeader('Access-Control-Expose-Headers', 'X-Waybills-Total, X-Waybills-Included, X-Waybills-Failed');
  res.send(buffer);
}

const ddmm = () => almatyNow().format('DD-MM');

/**
 * ZIP накладных по ВЫБРАННЫМ полкам: ?ids=a,b,c — id оптовиков,
 * ?marketplace=KASPI|OZON|WB (пусто — все три, каждая в своей папке),
 * ?from=&to= — период (как сверху на странице). Путь /waybills.zip объявлен
 * раньше /:id/..., чтобы «waybills.zip» не принимался за id.
 */
wholesalersRouter.get('/waybills.zip', async (req, res) => {
  try {
    const marketplaces = parseMarketplaces(req.query.marketplace);
    if (!marketplaces) return res.status(400).json({ error: 'Площадка должна быть KASPI, OZON или WB' });
    const ids = String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Не выбрано ни одной полки' });
    const wholesalers: Array<{ id: string; firstName: string; lastName: string }> = await prisma.wholesaler.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'asc' },
    });
    if (!wholesalers.length) return res.status(404).json({ error: 'Оптовики не найдены' });
    const { from, to } = parseRange(req.query as Record<string, unknown>);

    const jobs: WaybillJob[] = [];
    for (const w of wholesalers) jobs.push(...(await collectJobs(w, marketplaces, from, to)));
    if (!jobs.length) return res.status(404).json({ error: 'За выбранный период нет заказов по товарам этих оптовиков' });

    await sendZip(res, jobs, {
      multipleWholesalers: wholesalers.length > 1,
      multipleMarketplaces: marketplaces.length > 1,
      fileName: wholesalers.length > 1
        ? `Накладные_оптовики_${ddmm()}.zip`
        : `${safeName(`${wholesalers[0].firstName}_${wholesalers[0].lastName}`)}_${marketplaces.length > 1 ? 'все-площадки' : MARKETPLACE_LABEL[marketplaces[0]]}_${ddmm()}.zip`,
    });
  } catch (err: any) {
    logger.error({ err }, '[Wholesalers] GET /waybills.zip упал');
    res.status(500).json({ error: 'Не удалось собрать накладные', details: String(err?.message ?? err) });
  }
});

/** ZIP накладных ОДНОЙ полки оптовика. */
wholesalersRouter.get('/:id/waybills.zip', async (req, res) => {
  try {
    const marketplaces = parseMarketplaces(req.query.marketplace);
    if (!marketplaces) return res.status(400).json({ error: 'Площадка должна быть KASPI, OZON или WB' });
    const wholesaler = await prisma.wholesaler.findUnique({ where: { id: req.params.id } });
    if (!wholesaler) return res.status(404).json({ error: 'Оптовик не найден' });
    const { from, to } = parseRange(req.query as Record<string, unknown>);

    const jobs = await collectJobs(wholesaler, marketplaces, from, to);
    if (!jobs.length) return res.status(404).json({ error: 'За выбранный период нет заказов по товарам этого оптовика' });

    await sendZip(res, jobs, {
      multipleWholesalers: false,
      multipleMarketplaces: marketplaces.length > 1,
      fileName: `${safeName(`${wholesaler.firstName}_${wholesaler.lastName}`)}_${marketplaces.length > 1 ? 'все-площадки' : MARKETPLACE_LABEL[marketplaces[0]]}_${ddmm()}.zip`,
    });
  } catch (err: any) {
    logger.error({ err }, '[Wholesalers] GET /:id/waybills.zip упал');
    res.status(500).json({ error: 'Не удалось собрать накладные', details: String(err?.message ?? err) });
  }
});

/**
 * Одна накладная PDF по строке товара: на ПОСЛЕДНИЙ (не отменённый и не
 * возвращённый) заказ этого товара на выбранной площадке. В накладной — этот
 * товар и остальные товары того же оптовика из этого же заказа; город — из заказа.
 */
wholesalersRouter.get('/products/:productId/waybill.pdf', async (req, res) => {
  try {
    const marketplaces = parseMarketplaces(req.query.marketplace);
    if (!marketplaces || marketplaces.length !== 1) return res.status(400).json({ error: 'Укажите площадку: KASPI, OZON или WB' });
    const marketplace = marketplaces[0];
    const productId = req.params.productId;

    const link: any = await prisma.wholesalerProduct.findUnique({ where: { productId }, include: { wholesaler: true } });
    let sameShelfIds = new Set<string>([productId]);
    let wholesalerName = 'Без оптовика';
    if (link) {
      const siblings: Array<{ productId: string }> = await prisma.wholesalerProduct.findMany({
        where: { wholesalerId: link.wholesalerId },
        select: { productId: true },
      });
      sameShelfIds = new Set(siblings.map((s) => s.productId));
      wholesalerName = `${link.wholesaler.firstName} ${link.wholesaler.lastName}`;
    }

    const orders: any[] = await prisma.order.findMany({
      where: { marketplace, items: { some: { productId } } },
      orderBy: { orderDate: 'desc' },
      take: 30,
      include: ORDER_INCLUDE,
    });
    const order = orders.find((o) => isShippableStatus(o.status));
    if (!order) return res.status(404).json({ error: 'По этому товару на выбранной площадке нет заказов для накладной' });

    const items: WholesalerWaybillItem[] = order.items
      .filter((i: any) => i.productId && sameShelfIds.has(i.productId))
      .map((i: any) => ({
        sku: i.product?.sku ?? i.externalSku,
        article: articleFor(marketplace, i.product, i.externalSku),
        name: i.name,
        quantity: i.quantity,
      }));
    const pdf = await generateWholesalerWaybillPdf({
      wholesalerName,
      marketplace,
      orderNumber: order.externalId,
      orderDate: order.orderDate,
      city: order.city ?? null,
      items,
    });
    const fileName = `waybill-${MARKETPLACE_LABEL[marketplace]}-${safeName(order.externalId)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(pdf);
  } catch (err: any) {
    logger.error({ err }, '[Wholesalers] GET /products/:productId/waybill.pdf упал');
    res.status(500).json({ error: 'Не удалось собрать накладную', details: String(err?.message ?? err) });
  }
});
