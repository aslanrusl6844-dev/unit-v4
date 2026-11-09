import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../db/prisma';
import { NormalizedOrder, NormalizedOrderItem } from '../types';
import { cleanOzonDescription, cleanOzonComposition, isCompositionAttributeName, isMaterialAttributeName, isGarbageValue } from './ozon.content';

/**
 * Клиент для Ozon Seller API.
 * Документация: https://docs.ozon.ru/api/seller
 *
 * Заказы берём через POST /v4/posting/fbs/list (курсор),
 * а реальные удержания (комиссия, логистика, эквайринг) — через
 * POST /v3/finance/transaction/list, т.к. в самом заказе комиссия не всегда
 * отражена финально (может меняться после начисления).
 *
 * Client-Id/Api-Key берутся ДИНАМИЧЕСКИ: сначала пробуем найти сохранённый
 * магазин в базе (форма в разделе «Настройки»), и только если его нет —
 * используем OZON_CLIENT_ID/OZON_API_KEY из переменных окружения (для
 * обратной совместимости с тем, кто настраивал сервер до появления формы).
 */

interface OzonCredentials {
  clientId: string;
  apiKey: string;
  baseUrl: string;
}

async function getOzonCredentials(): Promise<OzonCredentials | null> {
  const store = await prisma.ozonStore.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (store?.clientId && store?.apiKey) {
    return { clientId: store.clientId, apiKey: store.apiKey, baseUrl: env.ozon.baseUrl };
  }
  if (env.ozon.clientId && env.ozon.apiKey) {
    return { clientId: env.ozon.clientId, apiKey: env.ozon.apiKey, baseUrl: env.ozon.baseUrl };
  }
  return null;
}

export interface OzonPostingFinance {
  commission: number;
  logistics: number;
  acquiring: number;
  other: number;
  revenue: number;
  /** Сумма всех начислений по отправлению = к выплате от Ozon. */
  payout: number;
  /** Дата первого начисления (Ozon засчитал продажу) — по ней заказ попадает в период выплаты. */
  settledAt: Date | null;
}

export interface OzonCashFlow {
  periodId: string;
  begin: string | null;
  end: string | null;
  ordersAmount: number;
  returnsAmount: number;
  commissionAmount: number;
  servicesAmount: number;
  deliveryAndReturnAmount: number;
  payments: number;
  beginBalance: number | null;
  endBalance: number | null;
  currency: string | null;
}

interface OzonPostingProduct {
  sku: number;
  offer_id: string;
  name: string;
  quantity: number;
  price: string | { amount?: string | number; currency?: string } | number;
}

/** В v4 цена приходит объектом {amount, currency}, раньше — строкой. */
function ozonMoney(v: unknown): number {
  if (v && typeof v === 'object') return Number((v as { amount?: unknown }).amount ?? 0) || 0;
  return Number(v ?? 0) || 0;
}

interface OzonPosting {
  posting_number: string;
  order_id: number;
  order_number: string;
  status: string;
  in_process_at: string;
  shipment_date: string;
  delivery_method?: { name?: string };
  analytics_data?: { city?: string; delivery_type?: string };
  products: OzonPostingProduct[];
}

interface OzonFinanceTransaction {
  operation_type: string;
  operation_type_name: string;
  posting: { posting_number: string };
  amount: number; // сумма операции (может быть отрицательной = списание)
  accruals_for_sale?: number;
  sale_commission?: number;
  delivery_charge?: number;
  return_delivery_charge?: number;
  services?: { name: string; price: number }[];
}

/**
 * ВАЖНО (проверено официально, Telegram-канал Ozon Seller API, запись от
 * 14 июля 2026): методы POST /v3/finance/transaction/list и .../totals
 * ОТКЛЮЧЕНЫ Ozon 8 сентября 2026 ("obsolete method cannot be used").
 * Официальная замена — три отдельных метода:
 *   POST /v1/finance/accrual/postings — начисления по отправлениям
 *   POST /v1/finance/accrual/types — справочник типов начислений
 *   POST /v1/finance/accrual/by-day — агрегаты по дням
 *
 * Два официальных ограничения нового API (сам Ozon об этом пишет в
 * документации):
 *  1. Максимум ~30 дней в одном запросе (было — без ограничений) — поэтому
 *     ниже период режется на месячные куски, как и у Kaspi с их лимитом.
 *  2. Дословная цитата из документации Ozon: "Данные могут не соответствовать
 *     информации в личном кабинете" — это официальная оговорка САМОГО Ozon,
 *     не наша неточность. Обязательно показываем это предупреждение в
 *     интерфейсе рядом с цифрами Ozon (см. index.html).
 *
 * Точная JSON-схема нового ответа не задокументирована публично так же
 * подробно, как была у старого метода (независимые разработчики, уже
 * мигрировавшие, тоже отмечают недостающие поля и нестабильность). Разбор
 * ниже сделан МАКСИМАЛЬНО терпимым к разным вариантам названий полей —
 * при любой нестыковке в лог пишется ПОЛНОЕ тело ответа Ozon, чтобы можно
 * было быстро уточнить точные названия по факту, не гадая заново.
 */
/** Ссылки на фото из ответа /v3/product/info/list: primary_image (массив
 *  или строка) + images, главное первым, без дублей и пустых, до 10 штук. */
function collectOzonImages(primary?: string[] | string, images?: string[]): string[] {
  const list: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string' && /^https?:\/\//.test(v.trim())) list.push(v.trim()); };
  if (Array.isArray(primary)) primary.forEach(push); else push(primary);
  if (Array.isArray(images)) images.forEach(push);
  return Array.from(new Set(list)).slice(0, 10);
}


export interface OzonProductContent {
  offerId: string;
  /** Тип товара на Ozon (атрибут «Тип»), если Ozon его отдал и он не пустышка. */
  typeName?: string;
  /** Описание — ТОЛЬКО аннотация, уже очищенная. undefined = аннотации в ответе нет;
   *  '' = была, но после чистки (оферта, хештеги, доставка по РФ…) ничего не осталось. */
  description?: string;
  /** Чистый текст состава — ТОЛЬКО из отдельного поля «Состав» / «Состав/ингредиенты».
   *  undefined = такого поля у товара нет; '' = было, но пустое/мусорное. */
  composition?: string;
  /** Материал (для короткого списка характеристик), если значение нормальное. */
  material?: string;
}

const OZON_ATTR_ID_DESCRIPTION = 4191; // «Аннотация»
const OZON_ATTR_ID_TYPE = 8229;        // «Тип»

// Имена атрибутов по паре (категория, тип) не меняются — кэшируем в памяти,
// чтобы не спрашивать их у Ozon на каждой пачке.
const ozonAttrNamesCache = new Map<string, Map<number, string>>();

export interface OzonReturnRow {
  id: string;
  postingNumber: string;
  orderNumber: string;
  schema: string;            // FBS / FBO
  status: string;            // видимый статус возврата
  statusChangedAt: string | null;
  reason: string;            // причина возврата (как её пишет Ozon)
  productName: string;
  offerId: string;
  quantity: number;
  price: number;
  placeName: string;         // где сейчас / откуда
  placeAddress: string;
  targetPlaceName: string;   // куда направлен возврат
  targetPlaceAddress: string;
  returnedAt: string | null; // момент окончания логистики возврата
  raw: unknown;
}

function pickStr(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}

function normalizeOzonReturn(r: any): OzonReturnRow {
  const product = r?.product ?? {};
  const price = product?.price;
  return {
    id: String(r?.id ?? ''),
    postingNumber: pickStr(r?.posting_number),
    orderNumber: pickStr(r?.order_number, r?.order_id != null ? String(r.order_id) : ''),
    schema: pickStr(r?.schema, r?.return_schema),
    status: pickStr(r?.visual?.status?.display_name, r?.visual?.status?.sys_name, r?.status),
    statusChangedAt: pickStr(r?.visual?.change_moment) || null,
    reason: pickStr(r?.return_reason_name, r?.reason),
    productName: pickStr(product?.name, r?.product_name),
    offerId: pickStr(product?.offer_id, r?.offer_id),
    quantity: Number(product?.quantity ?? r?.quantity ?? (Array.isArray(r?.exemplars) ? r.exemplars.length : 1)) || 1,
    price: Number((price && typeof price === 'object' ? price.price : price) ?? 0) || 0,
    placeName: pickStr(r?.place?.name),
    placeAddress: pickStr(r?.place?.address),
    targetPlaceName: pickStr(r?.target_place?.name),
    targetPlaceAddress: pickStr(r?.target_place?.address),
    returnedAt: pickStr(r?.logistic?.final_moment, r?.logistic?.technical_return_moment) || null,
    raw: r,
  };
}

export interface OzonFboStockRow { sku: string; offerId: string; name: string; warehouse: string; free: number; reserved: number; promised: number }
export interface OzonFboPosting { postingNumber: string; status: string; createdAt: string | null; offerId: string; name: string; quantity: number; price: number }

export class OzonClient {
  async isConfigured(): Promise<boolean> {
    const creds = await getOzonCredentials();
    return Boolean(creds?.clientId && creds?.apiKey);
  }

  private async getHttp(): Promise<AxiosInstance> {
    const creds = await getOzonCredentials();
    if (!creds) {
      throw new Error('Ozon API не настроен: добавьте магазин в разделе «Настройки» или задайте OZON_CLIENT_ID/OZON_API_KEY в .env');
    }
    const http = axios.create({
      baseURL: creds.baseUrl,
      headers: {
        'Client-Id': creds.clientId,
        'Api-Key': creds.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });
    // Ozon ограничивает число запросов В СЕКУНДУ (429 «request rate limit per second»).
    // Такая ошибка проходит сама через секунду-другую — повторяем запрос до 4 раз с паузой,
    // а не роняем всю синхронизацию (из-за этого автообновление писало «не вышло: Ozon»).
    http.interceptors.response.use(undefined, async (err) => {
      const cfg: any = err?.config;
      if (err?.response?.status !== 429 || !cfg) throw err;
      cfg.__retry429 = (cfg.__retry429 ?? 0) + 1;
      if (cfg.__retry429 > 4) throw err;
      await new Promise((r) => setTimeout(r, 1200 * cfg.__retry429));
      return http.request(cfg);
    });
    return http;
  }

  /**
   * Полный каталог товаров, СЕЙЧАС стоящих на продаже (не из заказов, а из
   * собственного метода Ozon "список товаров"):
   *   POST /v3/product/list — постранично отдаёт {product_id, offer_id}
   *     (v2/product/list официально отключён Ozon 09.02.2025 — используем
   *     актуальную v3-версию, иначе получаем "404 page not found")
   *   POST /v3/product/info/list — по списку id отдаёт name/статус
   *     (v2/product/info(/list) официально отключён Ozon 17.02.2025)
   * filter.visibility — судя по точному тексту ошибки Ozon ("invalid value
   * for enum field visibility: [" — ошибка ровно на символе "[") это
   * ОБЫЧНАЯ СТРОКА (enum), а не массив, как я ошибочно поставил в прошлый
   * раз. Отправляем строкой "VISIBLE" — "сейчас видны покупателям", а не
   * вообще все когда-либо созданные товары (включая давно снятые с продажи).
   * Разбор ответа сделан устойчивым к структуре — проверяет и
   * data.result.items, и data.items — на случай мелких отличий между
   * версиями API.
   */
  async fetchCatalog(): Promise<Array<{ offerId: string; name: string; active: boolean; price?: number; images: string[] }>> {
    const http = await this.getHttp();
    const idPairs: Array<{ productId: number; offerId: string }> = [];
    let lastId = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let data: any;
      try {
        const response = await http.post('/v3/product/list', {
          filter: { visibility: 'VISIBLE' },
          last_id: lastId,
          limit: 100,
        });
        data = response.data;
      } catch (err: any) {
        const ozonErrorBody = err?.response?.data;
        logger.error({ status: err?.response?.status, body: ozonErrorBody }, '[Ozon] Ошибка запроса списка товаров');
        throw new Error(`Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе каталога: ${JSON.stringify(ozonErrorBody) || err?.message}`);
      }

      const result = data.result ?? data;
      const items: Array<{ product_id: number; offer_id: string }> = result?.items ?? [];
      items.forEach((i) => idPairs.push({ productId: i.product_id, offerId: i.offer_id }));

      lastId = result?.last_id ?? '';
      if (!items.length || !lastId) break;
    }

    logger.info(`[Ozon] В каталоге товаров (visibility=VISIBLE): ${idPairs.length}`);

    // Название и точный статус (archived) добираем пачками по 100 через info/list.
    const catalog: Array<{ offerId: string; name: string; active: boolean; price?: number; images: string[] }> = [];
    for (let i = 0; i < idPairs.length; i += 100) {
      const chunk = idPairs.slice(i, i + 100);
      try {
        const { data } = await http.post('/v3/product/info/list', {
          offer_id: chunk.map((c) => c.offerId),
        });
        const result = data.result ?? data;
        const items: Array<{ offer_id: string; name?: string; archived?: boolean; price?: string; primary_image?: string[] | string; images?: string[] }> = result?.items ?? [];
        items.forEach((item) => {
          catalog.push({
            offerId: item.offer_id,
            name: item.name?.trim() || `Ozon-товар ${item.offer_id}`,
            // Если поле archived не пришло — считаем товар активным (лучше
            // показать лишний товар, чем незаметно потерять настоящий).
            active: item.archived !== true,
            // Ozon отдаёт price строкой — переводим в число для расчётов.
            price: item.price ? Number(item.price) : undefined,
            // Фото только ЧИТАЕМ (то же поле ответа, что уже приходит) —
            // ничего на Ozon не меняем. Главное фото первым, без дублей.
            images: collectOzonImages(item.primary_image, item.images),
          });
        });
      } catch (err: any) {
        const ozonErrorBody = err?.response?.data;
        logger.error({ status: err?.response?.status, body: ozonErrorBody }, '[Ozon] Ошибка запроса деталей товаров');
        // Не прерываем всю синхронизацию из-за одной неудачной пачки — просто
        // пропускаем эти offer_id, остальные всё равно синхронизируются.
      }
    }

    return catalog;
  }


  /**
   * Описание, тип и характеристики товаров Ozon — ТОЛЬКО ЧТЕНИЕ:
   *   POST /v4/product/info/attributes — атрибуты по списку offer_id (до 1000),
   *     у каждого: description_category_id, type_id, attributes[{id, values[{value}]}];
   *   POST /v1/description-category/attribute — имена атрибутов для пары
   *     (категория, тип), чтобы характеристики получили названия.
   * Ничего на Ozon не создаётся и не меняется. Если имена атрибутов получить
   * не удалось — описание и тип всё равно возвращаются, без характеристик.
   */
  async fetchProductContent(offerIds: string[]): Promise<OzonProductContent[]> {
    if (!offerIds.length) return [];
    const http = await this.getHttp();
    let items: any[] = [];
    try {
      const { data } = await http.post('/v4/product/info/attributes', {
        filter: { offer_id: offerIds, visibility: 'ALL' },
        limit: Math.min(1000, Math.max(offerIds.length, 1)),
        sort_dir: 'ASC',
      });
      items = (data?.result ?? data?.items ?? []) as any[];
    } catch (err: any) {
      const ozonErrorBody = err?.response?.data;
      logger.error({ status: err?.response?.status, body: ozonErrorBody }, '[Ozon] Ошибка запроса атрибутов (/v4/product/info/attributes)');
      throw new Error(`Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе описаний: ${JSON.stringify(ozonErrorBody) || err?.message}`);
    }

    // Имена атрибутов — по каждой уникальной паре (категория, тип) один раз.
    const pairs = new Map<string, { categoryId: number; typeId: number }>();
    for (const it of items) {
      if (it?.description_category_id && it?.type_id) {
        pairs.set(`${it.description_category_id}:${it.type_id}`, { categoryId: it.description_category_id, typeId: it.type_id });
      }
    }
    for (const [key, pair] of pairs) {
      if (ozonAttrNamesCache.has(key)) continue;
      try {
        const { data } = await http.post('/v1/description-category/attribute', {
          description_category_id: pair.categoryId,
          type_id: pair.typeId,
          language: 'DEFAULT',
        });
        const names = new Map<number, string>();
        for (const a of (data?.result ?? []) as Array<{ id: number; name: string }>) {
          if (a?.id != null && a?.name) names.set(a.id, a.name);
        }
        ozonAttrNamesCache.set(key, names);
      } catch (err: any) {
        logger.warn({ status: err?.response?.status, pair: key }, '[Ozon] Не удалось получить названия атрибутов — характеристики этой категории пропущены');
        ozonAttrNamesCache.set(key, new Map());
      }
    }

    return items.map((it): OzonProductContent => {
      const names = ozonAttrNamesCache.get(`${it.description_category_id}:${it.type_id}`) ?? new Map<number, string>();
      let description: string | undefined;
      let composition: string | undefined;
      let material: string | undefined;
      let typeName: string | undefined;
      for (const attr of (it.attributes ?? []) as Array<{ id: number; values?: Array<{ value?: string }> }>) {
        const value = (attr.values ?? []).map((v) => String(v?.value ?? '').trim()).filter(Boolean).join(', ');
        if (!value) continue;
        const name = names.get(attr.id) ?? (attr.id === OZON_ATTR_ID_DESCRIPTION ? 'Аннотация' : attr.id === OZON_ATTR_ID_TYPE ? 'Тип' : undefined);
        if (attr.id === OZON_ATTR_ID_DESCRIPTION || name?.toLowerCase() === 'аннотация') {
          description = cleanOzonDescription(value);
        } else if (attr.id === OZON_ATTR_ID_TYPE || name?.toLowerCase() === 'тип') {
          if (!isGarbageValue(value)) typeName = value;
        } else if (isCompositionAttributeName(name)) {
          composition = cleanOzonComposition(value);
        } else if (isMaterialAttributeName(name)) {
          if (!isGarbageValue(value)) material = value;
        }
        // Все остальные атрибуты (бренд, пол, страна, ТН ВЭД, маркировка, код
        // продавца, хештеги…) сознательно игнорируются — в карточку не идут.
      }
      return { offerId: String(it.offer_id), typeName, description, composition, material };
    });
  }

  /**
   * Тарифная сетка расходов Ozon по каждому товару — POST /v5/product/info/prices.
   * Это ТА ЖЕ информация, что видна в кабинете Ozon → Цены и акции →
   * Управление ценами → "Расходы": вознаграждение Ozon (в %), логистика,
   * последняя миля, обратная логистика, эквайринг.
   *
   * ВАЖНО: это ПРЕДВАРИТЕЛЬНАЯ тарифная сетка "если продать по текущей
   * цене прямо сейчас", а не факт по уже состоявшейся продаже (факт даётся
   * отдельно — см. fetchFinanceByPosting, уже используется при синхронизации
   * заказов). Подтверждённый формат ответа (проверено по официальной
   * документации Ozon и рабочим примерам интеграторов):
   *   commissions.sales_percent_fbs — ставка вознаграждения Ozon по схеме
   *     FBS, в процентах КАК ЕСТЬ (27.5 значит 27.5%, без домножения/деления).
   *   commissions.fbs_direct_flow_trans_min_amount — магистральная логистика, ₸.
   *   commissions.fbs_deliv_to_customer_amount — последняя миля, ₸.
   *   commissions.fbs_return_flow_amount — обратная логистика (справочно,
   *     это стоимость ПРИ ВОЗВРАТЕ — условная, не считаем её в детерминированный
   *     прогноз прибыли по проданной единице, у нас нет вероятности возврата).
   *   acquiring — эквайринг, ₸ (верхний уровень ответа, не внутри commissions).
   * Схема FBS выбрана как основная — самая частая для обычных продавцов.
   * "Обработка отправления" из кабинета Ozon в этом ответе отдельным полем
   * НЕ приходит — не выдумываем цифру, просто не показываем эту строку.
   */
  async fetchPrices(offerIds: string[]): Promise<Map<string, {
    price?: number;
    commissionRatePct?: number;
    logisticsAmount?: number;
    lastMileAmount?: number;
    returnLogisticsAmount?: number;
    acquiringAmount?: number;
  }>> {
    const http = await this.getHttp();
    const result = new Map<string, any>();

    for (let i = 0; i < offerIds.length; i += 100) {
      const chunk = offerIds.slice(i, i + 100);
      try {
        const { data } = await http.post('/v5/product/info/prices', {
          filter: { offer_id: chunk, visibility: 'ALL' },
          limit: 100,
          cursor: '',
        });
        const items: any[] = data.items ?? data.result?.items ?? [];
        items.forEach((item) => {
          const c = item.commissions ?? {};
          result.set(item.offer_id, {
            price: sellingPrice(item.price),
            commissionRatePct: c.sales_percent_fbs != null ? Number(c.sales_percent_fbs) : undefined,
            logisticsAmount: c.fbs_direct_flow_trans_min_amount != null ? Number(c.fbs_direct_flow_trans_min_amount) : undefined,
            lastMileAmount: c.fbs_deliv_to_customer_amount != null ? Number(c.fbs_deliv_to_customer_amount) : undefined,
            returnLogisticsAmount: c.fbs_return_flow_amount != null ? Number(c.fbs_return_flow_amount) : undefined,
            acquiringAmount: item.acquiring != null ? Number(item.acquiring) : undefined,
          });
        });
      } catch (err: any) {
        const ozonErrorBody = err?.response?.data;
        logger.error({ status: err?.response?.status, body: ozonErrorBody }, '[Ozon] Ошибка запроса тарифов (/v5/product/info/prices)');
        // Не прерываем всю синхронизацию из-за одной неудачной пачки — просто
        // пропускаем эти offer_id, остальные всё равно синхронизируются.
      }
    }

    return result;
  }

  async fetchOrders(params: { dateFrom: Date; dateTo: Date }): Promise<NormalizedOrder[]> {
    const http = await this.getHttp();
    const postings = await this.fetchAllFbsPostings(http, params.dateFrom, params.dateTo);

    // ВАЖНО: /v1/finance/accrual/postings принимает posting_numbers
    // (от 1 до 200 штук за раз, НЕ диапазон дат) — Ozon явно вернул ошибку
    // валидации на пустой/слишком большой список. Поэтому сначала получаем
    // сами отправления (уже сделано выше), собираем их номера, и только
    // если список не пуст — идём в финансовый метод, пачками по 200.
    const postingNumbers = postings.map((p) => p.posting_number).filter(Boolean);
    const financeByPosting = postingNumbers.length > 0
      ? await this.fetchFinanceByPosting(http, postingNumbers)
      : new Map<string, OzonPostingFinance>();

    if (financeByPosting.size > 0) {
      const ourCommissionTotal = Array.from(financeByPosting.values()).reduce((sum, v) => sum + v.commission, 0);
      await this.logByDayReconciliation(http, params.dateFrom, params.dateTo, ourCommissionTotal);
    }

    const orders = postings.map((posting) => this.toNormalizedOrder(posting, financeByPosting.get(posting.posting_number)));

    logger.info(`[Ozon] Загружено отправлений: ${orders.length}`);
    return orders;
  }

  /**
   * Остатки на складах Ozon (FBO): POST /v2/analytics/stock_on_warehouses,
   * постранично (limit/offset). Поля ответа разбираются терпимо (rows может
   * лежать в result.rows или rows).
   */
  async fetchFboStocks(): Promise<OzonFboStockRow[]> {
    const http = await this.getHttp();
    const limit = 1000;
    const out: OzonFboStockRow[] = [];
    for (let page = 0; page < 30; page++) {
      let data: any;
      try {
        const response = await http.post('/v2/analytics/stock_on_warehouses', { limit, offset: page * limit, warehouse_type: 'ALL' });
        data = response.data;
      } catch (err: any) {
        const body = err?.response?.data;
        logger.error({ status: err?.response?.status, body }, '[Ozon] Ошибка запроса остатков FBO');
        throw new Error(`Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе остатков FBO: ${JSON.stringify(body) || err?.message || err}`);
      }
      const rows: any[] = data?.result?.rows ?? data?.rows ?? [];
      for (const r of rows) {
        out.push({
          sku: String(r?.sku ?? ''),
          offerId: pickStr(r?.item_code, r?.offer_id),
          name: pickStr(r?.item_name, r?.name),
          warehouse: pickStr(r?.warehouse_name),
          free: Number(r?.free_to_sell_amount ?? 0) || 0,
          reserved: Number(r?.reserved_amount ?? 0) || 0,
          promised: Number(r?.promised_amount ?? 0) || 0,
        });
      }
      if (rows.length < limit) break;
    }
    return out;
  }

  /** Отправления FBO за период: POST /v3/posting/fbo/list (постранично по offset). */
  async fetchFboPostings(dateFrom: Date, dateTo: Date): Promise<OzonFboPosting[]> {
    const http = await this.getHttp();
    const limit = 100; // Ozon: Limit должен быть в диапазоне (0, 100]
    const out: OzonFboPosting[] = [];
    for (let page = 0; page < 200; page++) {
      let data: any;
      try {
        const response = await http.post('/v3/posting/fbo/list', {
          dir: 'ASC',
          filter: { since: dateFrom.toISOString(), to: dateTo.toISOString() },
          limit,
          offset: page * limit,
          with: { analytics_data: true, financial_data: false },
        });
        data = response.data;
      } catch (err: any) {
        const body = err?.response?.data;
        logger.error({ status: err?.response?.status, body }, '[Ozon] Ошибка запроса отправлений FBO');
        throw new Error(`Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе продаж FBO: ${JSON.stringify(body) || err?.message || err}`);
      }
      const list: any[] = Array.isArray(data?.result) ? data.result : (data?.result?.postings ?? data?.postings ?? []);
      for (const p of list) {
        for (const prod of Array.isArray(p?.products) ? p.products : []) {
          const price = prod?.price;
          out.push({
            postingNumber: pickStr(p?.posting_number),
            status: pickStr(p?.status),
            createdAt: pickStr(p?.created_at, p?.in_process_at) || null,
            offerId: pickStr(prod?.offer_id),
            name: pickStr(prod?.name),
            quantity: Number(prod?.quantity ?? 1) || 1,
            price: Number((price && typeof price === 'object' ? price.amount ?? price.price : price) ?? 0) || 0,
          });
        }
      }
      if (list.length < limit) break;
    }
    return out;
  }

  /**
   * Возвраты Ozon (FBS и FBO): POST /v1/returns/list.
   * Фильтр — по моменту смены статуса (visual_status_change_moment), пагинация
   * по last_id (+ has_next). Схема ответа публично описана неполно, поэтому
   * разбор терпимый, а сырой элемент возврата отдаётся целиком (raw) — чтобы
   * в интерфейсе можно было показать всё, что вернул Ozon.
   */
  async fetchReturns(dateFrom: Date, dateTo: Date): Promise<OzonReturnRow[]> {
    const http = await this.getHttp();
    const rows: OzonReturnRow[] = [];
    let lastId = 0;
    for (let page = 0; page < 40; page++) {
      let data: any;
      try {
        const response = await http.post('/v1/returns/list', {
          filter: {
            visual_status_change_moment: { time_from: dateFrom.toISOString(), time_to: dateTo.toISOString() },
          },
          limit: 500,
          last_id: lastId,
        });
        data = response.data;
      } catch (err: any) {
        const body = err?.response?.data;
        logger.error({ status: err?.response?.status, body }, '[Ozon] Ошибка запроса возвратов (/v1/returns/list)');
        throw new Error(
          `Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе возвратов: ${JSON.stringify(body) || err?.message || err}`,
        );
      }
      const body = data?.result && !Array.isArray(data.returns) ? data.result : data;
      const list: any[] = Array.isArray(body?.returns) ? body.returns : [];
      for (const r of list) rows.push(normalizeOzonReturn(r));
      if (!list.length || body?.has_next !== true) break;
      const next = Number(list[list.length - 1]?.id);
      if (!next || next === lastId) break;
      lastId = next;
    }
    return rows;
  }

  /**
   * Точная форма запроса к Ozon (для диагностики — см. п.1 вопроса):
   *
   *   POST {OZON_API_BASE_URL}/v4/posting/fbs/list
   *   Headers:
   *     Client-Id: <из формы в Настройках или OZON_CLIENT_ID>
   *     Api-Key:   <из формы в Настройках или OZON_API_KEY>
   *     Content-Type: application/json
   *   Body:
   *     {
   *       "cursor": "",
   *       "filter": { "since": "<ISO-дата>", "to": "<ISO-дата>" },
   *       "limit": 100,
   *       "sort_dir": "ASC",
   *       "with": { "analytics_data": true, "financial_data": false }
   *     }
   */
  private async fetchAllFbsPostings(http: AxiosInstance, dateFrom: Date, dateTo: Date): Promise<OzonPosting[]> {
    // Ozon отключил POST /v3/posting/fbs/list (400 «obsolete method», затем 404).
    // Замена — POST /v4/posting/fbs/list: постраничность не по offset, а по
    // курсору (в запросе cursor, в ответе cursor + has_next).
    const limit = 100;
    let cursor = '';
    const all: OzonPosting[] = [];
    const seenCursors = new Set<string>();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const requestBody = {
        cursor,
        filter: {
          since: dateFrom.toISOString(),
          to: dateTo.toISOString(),
        },
        limit,
        sort_dir: 'ASC',
        with: { analytics_data: true, financial_data: false },
      };

      let data: any;
      try {
        const response = await http.post('/v4/posting/fbs/list', requestBody);
        data = response.data;
      } catch (err: any) {
        const ozonErrorBody = err?.response?.data;
        logger.error(
          { status: err?.response?.status, body: ozonErrorBody, requestBody },
          '[Ozon] Ошибка запроса заказов (v4/posting/fbs/list)',
        );
        throw new Error(
          `Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе заказов: ` +
            `${JSON.stringify(ozonErrorBody) || err?.message || err}`,
        );
      }

      // Ответ может прийти как {postings,...} или в обёртке {result:{postings,...}}.
      const body = data?.result && !Array.isArray(data.postings) ? data.result : data;
      const postings: OzonPosting[] = Array.isArray(body?.postings) ? body.postings : [];
      all.push(...postings);

      const nextCursor: string = typeof body?.cursor === 'string' ? body.cursor : '';
      const hasNext = body?.has_next === true;
      if (!hasNext || !nextCursor || postings.length === 0 || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return all;
  }

  /**
   * Финансовые транзакции содержат фактическую комиссию за продажу,
   * стоимость логистики/обратной логистики и доп. услуги (упаковка,
   * эквайринг и т.д.), сгруппированные по posting_number.
   *
   * ВАЖНО (уточнено по точной ошибке валидации от самого Ozon):
   * /v1/finance/accrual/postings принимает поле "posting_numbers" —
   * СПИСОК номеров отправлений, а не диапазон дат. Ограничение — от 1 до
   * 200 номеров за один запрос. Если список пуст (заказов за период нет) —
   * метод вызывать вообще не нужно, Ozon в любом случае откажет с ошибкой
   * валидации на пустом массиве.
   */
  /** Начисления по списку отправлений (для уже сохранённых заказов). */
  async fetchFinanceForPostings(postingNumbers: string[]): Promise<Map<string, OzonPostingFinance>> {
    const http = await this.getHttp();
    return this.fetchFinanceByPosting(http, postingNumbers);
  }

  /** Статусы FBS-отправлений за период (для обновления старых заказов: в пути → доставлен/отменён). */
  async fetchPostingStatuses(dateFrom: Date, dateTo: Date): Promise<Map<string, string>> {
    const http = await this.getHttp();
    const postings = await this.fetchAllFbsPostings(http, dateFrom, dateTo);
    return new Map(postings.map((p) => [p.posting_number, p.status]));
  }

  /** Справочник видов начислений Ozon (id → название), кэш на время жизни функции. */
  private accrualTypes: Map<number, string> | null = null;
  async fetchAccrualTypes(http?: AxiosInstance): Promise<Map<number, string>> {
    if (this.accrualTypes) return this.accrualTypes;
    const h = http ?? (await this.getHttp());
    const map = new Map<number, string>();
    try {
      const { data } = await h.post('/v1/finance/accrual/types', {});
      for (const t of data?.accrual_types ?? data?.result?.accrual_types ?? []) map.set(Number(t.id), String(t.name ?? t.description ?? ''));
      logger.info({ types: Array.from(map.entries()) }, '[Ozon] Справочник начислений');
    } catch (err: any) {
      logger.warn({ status: err?.response?.status, body: err?.response?.data }, '[Ozon] Не удалось получить справочник начислений');
    }
    this.accrualTypes = map;
    return map;
  }

  /**
   * Начисления по отправлениям: POST /v1/finance/accrual/postings (до 200 номеров за раз).
   * Ответ: posting_accruals[] → { posting_number, accruals[] { accrual_date, accrued{amount}, type_id, sku, quantity, seller_price } }.
   * Сумма accrued по отправлению = сколько Ozon начислил продавцу (выручка «+», удержания «−»),
   * т.е. это и есть «к выплате» по заказу. Вид удержания определяем по названию из справочника.
   */
  async fetchFinanceByPosting(
    http: AxiosInstance,
    postingNumbers: string[],
  ): Promise<Map<string, OzonPostingFinance>> {
    const result = new Map<string, OzonPostingFinance>();
    if (postingNumbers.length === 0) return result;
    const types = await this.fetchAccrualTypes(http);
    const BATCH_SIZE = 200;
    let logged = false;

    for (let i = 0; i < postingNumbers.length; i += BATCH_SIZE) {
      const batch = postingNumbers.slice(i, i + BATCH_SIZE);
      let data: any;
      try {
        const response = await http.post('/v1/finance/accrual/postings', { posting_numbers: batch });
        data = response.data;
      } catch (err: any) {
        const ozonErrorBody = err?.response?.data;
        logger.error({ status: err?.response?.status, body: ozonErrorBody, batchSize: batch.length }, '[Ozon] Ошибка запроса начислений (/v1/finance/accrual/postings)');
        throw new Error(`Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе начислений: ${JSON.stringify(ozonErrorBody) || err?.message || err}.`);
      }
      const postings: any[] = data?.posting_accruals ?? data?.result?.posting_accruals ?? data?.postings ?? [];
      if (!logged && postings.some((p) => (p.accruals ?? []).length)) {
        logged = true;
        logger.info({ sample: postings.find((p) => (p.accruals ?? []).length) }, '[Ozon] Пример начислений по отправлению');
      }
      for (const posting of postings) {
        const postingNumber = posting.posting_number;
        const accruals: any[] = posting.accruals ?? [];
        if (!postingNumber || accruals.length === 0) continue;
        // В начислениях по отправлению Ozon присылает только УДЕРЖАНИЯ (со знаком «−»): комиссию
        // за продажу (появляется при доставке покупателю), логистику, штрафы и т.п. Выручки там нет —
        // её берём из самого заказа. Названия видов — английские (Acquiring, LastMile, ...).
        const f: OzonPostingFinance = { commission: 0, logistics: 0, acquiring: 0, other: 0, revenue: 0, payout: 0, settledAt: null };
        for (const acc of accruals) {
          const amount = Number(acc?.accrued?.amount ?? acc?.amount ?? 0) || 0;
          if (!amount) continue;
          const name = types.get(Number(acc.type_id)) ?? '';
          const date = acc.accrual_date ? new Date(acc.accrual_date) : null;
          if (amount > 0 && /sale|revenue|выручк|продаж/i.test(name) && !/commission/i.test(name)) { f.revenue += amount; continue; }
          const fee = -amount; // удержание «−» → положительная сумма; возврат удержания «+» → уменьшает
          const kind = ozonFeeKind(name);
          f[kind] += fee;
          // Комиссия за продажу начисляется, когда покупатель получил товар, — это и есть дата продажи.
          if (kind === 'commission' && date && !isNaN(+date) && (!f.settledAt || date < f.settledAt)) f.settledAt = date;
        }
        // К выплате без выручки: −(все удержания). Выручку прибавит тот, кто знает сумму заказа.
        f.payout = Math.round(-(f.commission + f.logistics + f.acquiring + f.other) * 100) / 100;
        result.set(postingNumber, f);
      }
    }
    return result;
  }

  /** Финансовый отчёт по периодам выплат (1–15 и 16–конец месяца): POST /v1/finance/cash-flow-statement/list. */
  async fetchCashFlows(from: Date, to: Date): Promise<OzonCashFlow[]> {
    const http = await this.getHttp();
    const out: OzonCashFlow[] = [];
    for (let page = 1; page <= 20; page++) {
      const { data } = await http.post('/v1/finance/cash-flow-statement/list', {
        date: { from: from.toISOString(), to: to.toISOString() },
        with_details: true,
        page,
        page_size: 1,
      });
      const r = data?.result ?? {};
      for (const c of r.cash_flows ?? []) {
        const d = r.details ?? {};
        out.push({
          periodId: String(c.period?.id ?? ''),
          begin: c.period?.begin ?? null,
          end: c.period?.end ?? null,
          ordersAmount: Number(c.orders_amount) || 0,
          returnsAmount: Number(c.returns_amount) || 0,
          commissionAmount: Number(c.commission_amount) || 0,
          servicesAmount: Number(c.services_amount) || 0,
          deliveryAndReturnAmount: Number(c.item_delivery_and_return_amount) || 0,
          payments: (d.payments ?? []).reduce((s: number, p: any) => s + (Number(p.payment) || 0), 0),
          beginBalance: d.begin_balance_amount != null ? Number(d.begin_balance_amount) : null,
          endBalance: d.end_balance_amount != null ? Number(d.end_balance_amount) : null,
          currency: c.currency_code ?? null,
        });
      }
      if (page >= Number(r.page_count ?? data?.page_count ?? 1)) break;
    }
    return out;
  }

  /** Баланс за период до 30 дней: POST /v1/finance/balance (Финансы → Баланс в кабинете). */
  async fetchBalance(from: Date, to: Date): Promise<{ opening: number | null; closing: number | null; accrued: number | null; paid: number; currency: string | null }> {
    const http = await this.getHttp();
    const { data } = await http.post('/v1/finance/balance', { date_from: from.toISOString().slice(0, 10), date_to: to.toISOString().slice(0, 10) });
    const t = data?.total ?? data?.result?.total ?? {};
    const v = (x: any) => (x?.value != null ? Number(x.value) : null);
    return {
      opening: v(t.opening_balance),
      closing: v(t.closing_balance),
      accrued: v(t.accrued),
      paid: (t.payments ?? []).reduce((s: number, p: any) => s + Math.abs(Number(p?.value) || 0), 0),
      currency: t.closing_balance?.currency_code ?? null,
    };
  }

  /**
   * Агрегаты по дням — /v1/finance/accrual/by-day. Используем как СВЕРКУ
   * (не как основной источник данных): сравниваем сумму комиссии, которую
   * насчитали по отдельным отправлениям, с тем, что Ozon агрегирует сам по
   * дням за тот же период. Если сильно расходится — это подтверждает
   * официальную оговорку самого Ozon ("данные могут не соответствовать
   * личному кабинету") и стоит записать в лог, но НЕ должно ронять всю
   * синхронизацию — это диагностика, а не обязательный шаг.
   */
  private async logByDayReconciliation(http: AxiosInstance, dateFrom: Date, dateTo: Date, ourCommissionTotal: number): Promise<void> {
    try {
      const { data } = await http.post('/v1/finance/accrual/by-day', {
        date: { from: dateFrom.toISOString().slice(0, 10), to: dateTo.toISOString().slice(0, 10) },
      });
      const days: any[] = data.days ?? data.result?.days ?? data.items ?? [];
      const byDayTotal = days.reduce((sum, d) => sum + Math.abs(Number(d.sale_commission ?? d.commission ?? d.amount ?? 0)), 0);
      if (byDayTotal > 0 && Math.abs(byDayTotal - ourCommissionTotal) / byDayTotal > 0.05) {
        logger.warn(
          { byDayTotal, ourCommissionTotal },
          '[Ozon] Сумма комиссии по отправлениям заметно отличается от агрегата /accrual/by-day за тот же период — это ожидаемо (Ozon сам предупреждает, что данные API могут не совпадать с личным кабинетом)',
        );
      }
    } catch (err: any) {
      // Это сверка, а не обязательный шаг — не роняем синхронизацию, если
      // by-day недоступен или вернул неожиданный формат.
      logger.warn({ status: err?.response?.status }, '[Ozon] Не удалось сверить итоги по /accrual/by-day (не критично)');
    }
  }

  private toNormalizedOrder(
    posting: OzonPosting,
    finance?: OzonPostingFinance,
  ): NormalizedOrder {
    const items: NormalizedOrderItem[] = (posting.products ?? []).map((p) => ({
      externalSku: p.offer_id,
      name: p.name,
      quantity: p.quantity,
      price: ozonMoney(p.price),
    }));

    const totalRevenue = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

    return {
      externalId: posting.posting_number,
      marketplace: 'OZON',
      status: posting.status,
      orderDate: new Date(posting.in_process_at ?? posting.shipment_date),
      deliveryType: posting.analytics_data?.delivery_type ?? posting.delivery_method?.name,
      city: posting.analytics_data?.city,
      totalRevenue,
      marketplaceCommission: finance?.commission ?? 0,
      logisticsCost: finance?.logistics ?? 0,
      acquiringCost: finance?.acquiring ?? 0,
      otherFees: finance?.other ?? 0,
      settledAt: finance?.settledAt ?? null,
      payoutAmount: finance ? finance.payout : null,
      items,
      raw: posting,
    };
  }
}

export const ozonClient = new OzonClient();

/**
 * Цена, по которой товар СЕЙЧАС продаётся на Ozon: если действует акция продавца,
 * Ozon присылает её в marketing_seller_price (она ниже обычной price) — берём её,
 * иначе обычную цену. Так юнит-экономика считается по реальной продажной цене.
 */
export function sellingPrice(p: any): number | undefined {
  const base = Number(p?.price) || 0;
  const promo = Number(p?.marketing_seller_price) || 0;
  const v = promo > 0 && (base <= 0 || promo < base) ? promo : base;
  return v > 0 ? v : undefined;
}

/** Вид удержания Ozon по английскому названию из справочника /v1/finance/accrual/types. */
export function ozonFeeKind(name: string): 'commission' | 'logistics' | 'acquiring' | 'other' {
  if (/commission/i.test(name)) return 'commission';
  if (/acquiring|installment/i.test(name)) return 'acquiring';
  if (/logistic|lastmile|last mile|drop-?off|pick-?up|crossdock|fulfillment|shipment|delivery|packing|return|placement|storage/i.test(name)) return 'logistics';
  return 'other';
}
