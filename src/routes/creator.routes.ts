import { Router } from 'express';
import { SHOP_CATEGORIES } from '../config/shopCategories';
import { creatorGiftCoins } from '../services/liveGifts.service';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { normalizePhone } from './shop.routes';
import { approveApplication, CREATOR_DEFAULT_PERCENT, normalizePercent, parseAnswers } from '../services/creator.service';

/**
 * Креаторы My Market Live.
 * Приложение (x-app-key): /api/shop/creator/apply, /api/shop/creator/me.
 * Админка (Basic): /api/shop-admin/creators/...
 */
export const creatorRouter = Router();
export const creatorAdminRouter = Router();

creatorRouter.use((req, res, next) => {
  if (!env.shopAppKey) return res.status(503).json({ error: 'SHOP_APP_KEY не настроен' });
  if (req.header('x-app-key') !== env.shopAppKey) return res.status(401).json({ error: 'Неверный x-app-key' });
  next();
});

const str = (max: number) => z.string().trim().max(max).optional().default('');
const answersSchema = z.object({
  ageRange: str(20),
  language: str(30),
  socials: str(400),
  followers: str(40),
  experience: str(1000),
  phoneModel: str(80),
  equipment: str(200), // штатив, кольцевая лампа
  stableInternet: str(20),
  hoursPerWeek: str(20),
  timeOfDay: str(60),
  format: str(40), // короткие видео / эфиры / оба
  interests: z.array(z.string().trim().max(40)).max(12).optional().default([]),
  kids: str(200),
  motivation: str(1000),
}).partial();

const applySchema = z.object({
  phone: z.string().min(5).max(30),
  name: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(80),
  answers: answersSchema.optional().default({}),
  trialVideoUrl: z.string().trim().url().startsWith('https://').max(600).optional().nullable(),
  consentPersonalData: z.literal(true),
  consentRules: z.literal(true),
  adult: z.literal(true),
});

/** Заявка «Я креатор». Повторная подача, пока заявка на рассмотрении, — обновляет анкету. */
creatorRouter.post('/apply', async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Заполните анкету и отметьте согласия', details: parsed.error.flatten() });
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: 'Некорректный номер телефона' });
  const d = parsed.data;
  const data = {
    name: d.name,
    city: d.city,
    answers: JSON.stringify({ ...d.answers, consents: { personalData: true, rules: true, adult: true, at: new Date().toISOString() } }),
    trialVideoUrl: d.trialVideoUrl || null,
  };
  try {
    const existing = await prisma.creatorApplication.findUnique({ where: { phone } });
    if (existing && existing.status !== 'pending') return res.json({ status: existing.status });
    const app = existing
      ? await prisma.creatorApplication.update({ where: { phone }, data })
      : await prisma.creatorApplication.create({ data: { ...data, phone, status: 'pending' } });
    res.status(existing ? 200 : 201).json({ status: app.status });
  } catch (err: any) {
    logger.error({ err }, '[Creator] POST /apply упал');
    res.status(500).json({ error: 'Не удалось отправить заявку' });
  }
});

/** Статус креатора по телефону: none / pending / approved / rejected; у одобренного — код и процент. */
creatorRouter.get('/me', async (req, res) => {
  const phone = normalizePhone(String(req.query.phone ?? ''));
  if (!phone) return res.status(400).json({ error: 'Некорректный номер телефона' });
  try {
    const app = await prisma.creatorApplication.findUnique({ where: { phone } });
    if (!app) return res.json({ status: 'none' });
    if (app.status !== 'approved') return res.json({ status: app.status });
    const creator = await prisma.creator.findUnique({ where: { phone } });
    if (!creator || !creator.active) return res.json({ status: creator ? 'blocked' : 'pending' });
    res.json({ status: 'approved', creator: { code: creator.code, percent: creator.percent, name: creator.name } });
  } catch (err: any) {
    logger.error({ err }, '[Creator] GET /me упал');
    res.status(500).json({ error: 'Не удалось получить статус' });
  }
});

// ---------------------------------------------------------------------------
// Админка
// ---------------------------------------------------------------------------

creatorAdminRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

/** Заявки: ?status=pending|approved|rejected (по умолчанию pending). */
creatorAdminRouter.get('/applications', async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(String(req.query.status)) ? String(req.query.status) : 'pending';
  try {
    const rows = await prisma.creatorApplication.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 500 });
    res.json(rows.map((a: any) => ({ ...a, answers: parseAnswers(a.answers) })));
  } catch (err: any) {
    logger.error({ err }, '[Creator Admin] GET /applications упал');
    res.status(500).json({ error: 'Не удалось получить заявки' });
  }
});

creatorAdminRouter.post('/applications/:id/approve', async (req, res) => {
  const percent = normalizePercent(req.body?.percent ?? CREATOR_DEFAULT_PERCENT);
  if (percent == null) return res.status(400).json({ error: 'Процент — от 1 до 50' });
  try {
    const creator = await approveApplication(req.params.id, percent);
    if (!creator) return res.status(404).json({ error: 'Заявка не найдена' });
    res.json(creator);
  } catch (err: any) {
    logger.error({ err }, '[Creator Admin] approve упал');
    res.status(500).json({ error: 'Не удалось одобрить заявку' });
  }
});

creatorAdminRouter.post('/applications/:id/reject', async (req, res) => {
  const reason = String(req.body?.reason ?? '').trim().slice(0, 300) || null;
  try {
    const app = await prisma.creatorApplication.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Заявка не найдена' });
    const updated = await prisma.creatorApplication.update({ where: { id: app.id }, data: { status: 'rejected', reviewedAt: new Date(), rejectReason: reason } });
    // Одобренного раньше креатора — выключаем.
    await prisma.creator.updateMany({ where: { phone: app.phone }, data: { active: false } });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, '[Creator Admin] reject упал');
    res.status(500).json({ error: 'Не удалось отклонить заявку' });
  }
});

/** Вернуть отклонённую заявку на рассмотрение. */
creatorAdminRouter.post('/applications/:id/reopen', async (req, res) => {
  try {
    const app = await prisma.creatorApplication.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Заявка не найдена' });
    const updated = await prisma.creatorApplication.update({ where: { id: app.id }, data: { status: 'pending', reviewedAt: null, rejectReason: null } });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, '[Creator Admin] reopen упал');
    res.status(500).json({ error: 'Не удалось вернуть заявку' });
  }
});

/** Одобренные креаторы. */
creatorAdminRouter.get('/', async (_req, res) => {
  try {
    const rows: any[] = await prisma.creator.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 });
    const gifts = await creatorGiftCoins(rows.map((r) => r.id)).catch(() => new Map<string, number>());
    const owned: Array<{ sellerId: string | null }> = await prisma.product.findMany({ where: { sellerId: { not: null } }, select: { sellerId: true }, take: 200000 });
    const counts = new Map<string, number>();
    for (const o of owned) if (o.sellerId) counts.set(o.sellerId, (counts.get(o.sellerId) ?? 0) + 1);
    res.json({ items: rows.map((r) => ({ ...r, giftCoins: gifts.get(r.id) ?? 0, productsCount: counts.get(r.id) ?? 0 })), shopCategories: SHOP_CATEGORIES });
  } catch (err: any) {
    logger.error({ err }, '[Creator Admin] GET / упал');
    res.status(500).json({ error: 'Не удалось получить креаторов' });
  }
});

/** Поменять процент или включить/выключить креатора. */
creatorAdminRouter.patch('/:id', async (req, res) => {
  const data: Record<string, unknown> = {};
  if (req.body?.percent !== undefined) {
    const percent = normalizePercent(req.body.percent);
    if (percent == null) return res.status(400).json({ error: 'Процент — от 1 до 50' });
    data.percent = percent;
  }
  if (req.body?.active !== undefined) data.active = !!req.body.active;
  if (req.body?.autoPublish !== undefined) data.autoPublish = !!req.body.autoPublish;
  if (req.body?.featured !== undefined) data.featured = !!req.body.featured;
  if (req.body?.kind !== undefined) data.kind = req.body.kind === 'seller' ? 'seller' : 'creator';
  if (req.body?.companyName !== undefined) data.companyName = String(req.body.companyName ?? '').trim().slice(0, 120) || null;
  if (req.body?.bin !== undefined) {
    const bin = String(req.body.bin ?? '').replace(/\D/g, '');
    if (bin && bin.length !== 12) return res.status(400).json({ error: 'ИИН/БИН — 12 цифр' });
    data.bin = bin || null;
  }
  if (req.body?.category !== undefined) {
    const c = String(req.body.category ?? '').trim();
    if (c && !SHOP_CATEGORIES.includes(c)) return res.status(400).json({ error: 'Раздел не из каталога' });
    data.category = c || null;
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Нечего менять' });
  try {
    const creator = await prisma.creator.update({ where: { id: req.params.id }, data });
    res.json(creator);
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Креатор не найден' });
    logger.error({ err }, '[Creator Admin] PATCH упал');
    res.status(500).json({ error: 'Не удалось сохранить' });
  }
});


// ---- Товары продавца: какие товары каталога принадлежат продавцу (в эфире он показывает только их) ----

creatorAdminRouter.get('/:id/products', async (req, res) => {
  const rows: any[] = await prisma.product.findMany({
    where: { sellerId: req.params.id },
    select: { sku: true, name: true, shopArticle: true, shopPrice: true, category: true, shopActive: true, images: true },
    orderBy: { name: 'asc' },
    take: 20000,
  });
  res.json(rows.map((p) => {
    let img = '';
    try { img = (JSON.parse(p.images || '[]') as string[])[0] ?? ''; } catch { img = ''; }
    return { sku: p.sku, name: p.name, article: p.shopArticle ?? '', price: p.shopPrice ?? 0, category: p.category ?? '', active: !!p.shopActive, image: img };
  }));
});

/** { codes: ['артикул или sku', …], mode: 'add' | 'remove' } — закрепить товары за продавцом или снять. */
creatorAdminRouter.post('/:id/products', async (req, res) => {
  const c = await prisma.creator.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ error: 'Креатор не найден' });
  const codes: string[] = Array.from(new Set((Array.isArray(req.body?.codes) ? req.body.codes : []).map((x: unknown) => String(x ?? '').trim()).filter(Boolean))).slice(0, 5000) as string[];
  if (!codes.length) return res.status(400).json({ error: 'Укажите артикулы' });
  const remove = req.body?.mode === 'remove';
  const found: Array<{ id: string; sku: string; shopArticle: string | null; sellerId: string | null }> = await prisma.product.findMany({
    where: { OR: [{ sku: { in: codes } }, { shopArticle: { in: codes } }] },
    select: { id: true, sku: true, shopArticle: true, sellerId: true },
  });
  const matched = new Set(found.flatMap((p) => [p.sku, p.shopArticle ?? '']));
  const notFound = codes.filter((x) => !matched.has(x));
  const target = remove ? found.filter((p) => p.sellerId === c.id) : found;
  const busy = remove ? [] : found.filter((p) => p.sellerId && p.sellerId !== c.id).map((p) => p.sku);
  const ids = target.filter((p) => remove || !p.sellerId || p.sellerId === c.id).map((p) => p.id);
  const r = ids.length ? await prisma.product.updateMany({ where: { id: { in: ids } }, data: { sellerId: remove ? null : c.id } }) : { count: 0 };
  res.json({ ok: true, changed: r.count, notFound, busy });
});
