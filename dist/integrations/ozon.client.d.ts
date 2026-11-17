import { AxiosInstance } from 'axios';
import { NormalizedOrder } from '../types';
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
export interface OzonReturnRow {
    id: string;
    postingNumber: string;
    orderNumber: string;
    schema: string;
    status: string;
    statusChangedAt: string | null;
    reason: string;
    productName: string;
    offerId: string;
    quantity: number;
    price: number;
    placeName: string;
    placeAddress: string;
    targetPlaceName: string;
    targetPlaceAddress: string;
    returnedAt: string | null;
    statusSysName: string;
    arrivedAt: string | null;
    storage: Record<string, unknown> | null;
    raw: unknown;
}
export interface OzonFbsPostingBrief {
    postingNumber: string;
    status: string;
    inProcessAt: string | null;
    shipmentDate: string | null;
    products: {
        offerId: string;
        name: string;
        quantity: number;
        price: number;
    }[];
}
export interface OzonFboStockRow {
    sku: string;
    offerId: string;
    name: string;
    warehouse: string;
    free: number;
    reserved: number;
    promised: number;
}
export interface OzonFboPosting {
    postingNumber: string;
    status: string;
    createdAt: string | null;
    offerId: string;
    name: string;
    quantity: number;
    price: number;
}
export declare class OzonClient {
    isConfigured(): Promise<boolean>;
    private getHttp;
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
    fetchCatalog(): Promise<Array<{
        offerId: string;
        name: string;
        active: boolean;
        price?: number;
        images: string[];
    }>>;
    /**
     * Описание, тип и характеристики товаров Ozon — ТОЛЬКО ЧТЕНИЕ:
     *   POST /v4/product/info/attributes — атрибуты по списку offer_id (до 1000),
     *     у каждого: description_category_id, type_id, attributes[{id, values[{value}]}];
     *   POST /v1/description-category/attribute — имена атрибутов для пары
     *     (категория, тип), чтобы характеристики получили названия.
     * Ничего на Ozon не создаётся и не меняется. Если имена атрибутов получить
     * не удалось — описание и тип всё равно возвращаются, без характеристик.
     */
    fetchProductContent(offerIds: string[]): Promise<OzonProductContent[]>;
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
    fetchPrices(offerIds: string[]): Promise<Map<string, {
        price?: number;
        productId?: string;
        commissionRatePct?: number;
        logisticsAmount?: number;
        lastMileAmount?: number;
        returnLogisticsAmount?: number;
        acquiringAmount?: number;
    }>>;
    /** Текущие цены одного товара на Ozon: продажи, старая (зачёркнутая), минимальная для акций. */
    fetchPriceDetails(offerId: string): Promise<OzonPriceDetails | null>;
    /**
     * Поменять цены товара на Ozon (/v1/product/import/prices). oldPrice = 0 — убрать зачёркнутую цену;
     * minPrice = undefined — минимальную не трогаем. Возвращает ошибки Ozon текстом (пусто — принято).
     */
    updatePrice(input: {
        offerId: string;
        price: number;
        oldPrice: number;
        minPrice?: number;
        currency?: string | null;
    }): Promise<string[]>;
    fetchOrders(params: {
        dateFrom: Date;
        dateTo: Date;
    }): Promise<NormalizedOrder[]>;
    /** Отправления FBS за период (как пришли от Ozon): статус, срок отгрузки, товары. Для Озон-менеджера. */
    fetchFbsPostings(dateFrom: Date, dateTo: Date): Promise<OzonFbsPostingBrief[]>;
    /**
     * Остатки на складах Ozon (FBO): POST /v2/analytics/stock_on_warehouses,
     * постранично (limit/offset). Поля ответа разбираются терпимо (rows может
     * лежать в result.rows или rows).
     */
    fetchFboStocks(): Promise<OzonFboStockRow[]>;
    /** Отправления FBO за период: POST /v3/posting/fbo/list (постранично по offset). */
    fetchFboPostings(dateFrom: Date, dateTo: Date): Promise<OzonFboPosting[]>;
    /**
     * Возвраты Ozon (FBS и FBO): POST /v1/returns/list.
     * Фильтр — по моменту смены статуса (visual_status_change_moment), пагинация
     * по last_id (+ has_next). Схема ответа публично описана неполно, поэтому
     * разбор терпимый, а сырой элемент возврата отдаётся целиком (raw) — чтобы
     * в интерфейсе можно было показать всё, что вернул Ozon.
     */
    fetchReturns(dateFrom: Date | null, dateTo: Date | null): Promise<OzonReturnRow[]>;
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
    private fetchAllFbsPostings;
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
    /**
     * Цены в акциях Ozon, в которых товар СЕЙЧАС участвует: GET /v1/actions (участвуем, акция идёт)
     * → POST /v2/actions/products (action_price — цена продавца в акции). product_id → минимальная цена.
     * Это та цена, по которой товар реально продаётся, пока идёт акция (на 500–1000 ₸ ниже обычной).
     */
    fetchActionPrices(): Promise<Map<string, number>>;
    /** Начисления по списку отправлений (для уже сохранённых заказов). */
    fetchFinanceForPostings(postingNumbers: string[]): Promise<Map<string, OzonPostingFinance>>;
    /** Статусы FBS-отправлений за период (для обновления старых заказов: в пути → доставлен/отменён). */
    fetchPostingStatuses(dateFrom: Date, dateTo: Date): Promise<Map<string, string>>;
    /** Справочник видов начислений Ozon (id → название), кэш на время жизни функции. */
    private accrualTypes;
    fetchAccrualTypes(http?: AxiosInstance): Promise<Map<number, string>>;
    /**
     * Начисления по отправлениям: POST /v1/finance/accrual/postings (до 200 номеров за раз).
     * Ответ: posting_accruals[] → { posting_number, accruals[] { accrual_date, accrued{amount}, type_id, sku, quantity, seller_price } }.
     * Сумма accrued по отправлению = сколько Ozon начислил продавцу (выручка «+», удержания «−»),
     * т.е. это и есть «к выплате» по заказу. Вид удержания определяем по названию из справочника.
     */
    fetchFinanceByPosting(http: AxiosInstance, postingNumbers: string[]): Promise<Map<string, OzonPostingFinance>>;
    /** Финансовый отчёт по периодам выплат (1–15 и 16–конец месяца): POST /v1/finance/cash-flow-statement/list. */
    fetchCashFlows(from: Date, to: Date): Promise<OzonCashFlow[]>;
    /** Баланс за период до 30 дней: POST /v1/finance/balance (Финансы → Баланс в кабинете). */
    fetchBalance(from: Date, to: Date): Promise<{
        opening: number | null;
        closing: number | null;
        accrued: number | null;
        paid: number;
        currency: string | null;
    }>;
    /**
     * Агрегаты по дням — /v1/finance/accrual/by-day. Используем как СВЕРКУ
     * (не как основной источник данных): сравниваем сумму комиссии, которую
     * насчитали по отдельным отправлениям, с тем, что Ozon агрегирует сам по
     * дням за тот же период. Если сильно расходится — это подтверждает
     * официальную оговорку самого Ozon ("данные могут не соответствовать
     * личному кабинету") и стоит записать в лог, но НЕ должно ронять всю
     * синхронизацию — это диагностика, а не обязательный шаг.
     */
    private logByDayReconciliation;
    private toNormalizedOrder;
}
export declare const ozonClient: OzonClient;
/**
 * Цена, по которой товар СЕЙЧАС продаётся на Ozon: если действует акция продавца,
 * Ozon присылает её в marketing_seller_price (она ниже обычной price) — берём её,
 * иначе обычную цену. Так юнит-экономика считается по реальной продажной цене.
 */
export interface OzonPriceDetails {
    offerId: string;
    price: number | null;
    oldPrice: number | null;
    minPrice: number | null;
    /** Цена, по которой реально продаётся (с акцией продавца, если есть). */
    sellingPrice: number | null;
    currency: string | null;
}
export declare function sellingPrice(p: any): number | undefined;
/** Вид удержания Ozon по английскому названию из справочника /v1/finance/accrual/types. */
export declare function ozonFeeKind(name: string): 'commission' | 'logistics' | 'acquiring' | 'other';
