/** Статусы FBS, которые мы ещё не передали Ozon (нужно собрать / отгрузить). */
export declare const FBS_TO_SHIP: string[];
/** Отгрузки FBS: просроченные, сегодня, завтра, позже — по сроку shipment_date. */
export declare function fbsToShip(): Promise<{
    total: number;
    overdue: number;
    today: number;
    tomorrow: number;
    later: number;
    postings: {
        postingNumber: string;
        status: string;
        shipBy: string | null;
        bucket: string;
        needPacking: boolean;
        items: {
            offerId: string;
            name: string;
            qty: number;
            price: number;
        }[];
    }[];
}>;
/** Закупка под заказы FBS, которые ещё не собраны: сколько штук каждого товара и сколько денег по закупочной цене. */
export declare function purchaseNeeds(): Promise<{
    totalPurchase: number;
    positions: number;
    missingCost: string[];
    items: {
        unitCost: number;
        sum: number;
        noCost: boolean;
        offerId: string;
        name: string;
        qty: number;
        postings: number;
    }[];
}>;
/** Продажи за день: FBS из нашей базы (с комиссиями Ozon и себестоимостью) + FBO напрямую из Ozon. */
export declare function daySales(dateStr?: string, opts?: {
    sync?: boolean;
}): Promise<{
    date: string;
    fbs: {
        orders: number;
        revenue: number;
        cogs: number;
        fees: number;
        profit: number;
        list: {
            posting: string;
            status: string;
            revenue: number;
            cogs: number;
            fees: number;
            profit: number;
            feesPending: boolean;
            noCost: boolean;
            items: string[];
        }[];
    };
    fbo: {
        revenue: number;
        cogs: number;
        count: number;
        items: {
            name: string;
            qty: number;
            price: number;
        }[];
        error?: string;
    };
    cancelled: number;
}>;
/** Итог за период по Ozon (FBS): выручка, себестоимость, комиссии, логистика, налог, чистая прибыль, маржа, топ товаров. */
export declare function periodReport(fromStr: string, toStr: string): Promise<{
    from: string;
    to: string;
    summary: import("../types").UnitEconomicsSummary;
    topProfit: {
        name: any;
        qty: any;
        revenue: number;
        profit: number;
    }[];
    worst: {
        name: any;
        qty: any;
        revenue: number;
        profit: number;
    }[];
}>;
/** Возвраты Ozon за N дней: где сейчас, причина, сумма. */
export declare function returnsList(days?: number): Promise<{
    days: number;
    count: number;
    sum: number;
    byStatus: Record<string, number>;
    items: {
        posting: string;
        schema: string;
        status: string;
        reason: string;
        product: string;
        qty: number;
        price: number;
        place: string;
        changedAt: string | null;
    }[];
}>;
/** Остатки на складах Ozon (FBO) и на сколько дней хватит при продажах за 14 дней. */
export declare function fboStock(): Promise<{
    skus: number;
    totalFree: number;
    lowCount: number;
    low: {
        sold14: number;
        daysLeft: number | null;
        offerId: string;
        name: string;
        free: number;
    }[];
    outOfStockSelling: string[];
}>;
export declare function morningReport(): Promise<string>;
export declare function eveningReport(): Promise<string>;
export declare const OZON_TOOLS: readonly [{
    readonly name: "day_sales";
    readonly description: "Продажи Ozon за день (по умолчанию сегодня, Алматы): FBS-заказы с выручкой, закупкой, комиссиями Ozon, прибылью по каждому; FBO-продажи; отмены.";
    readonly input_schema: {
        readonly type: "object";
        readonly properties: {
            readonly date: {
                readonly type: "string";
                readonly description: "YYYY-MM-DD, пусто — сегодня";
            };
        };
    };
}, {
    readonly name: "period_report";
    readonly description: "Юнит-экономика Ozon за период: выручка, закупка, комиссии, логистика, реклама, налог, чистая прибыль, маржа, ROI, лучшие и убыточные товары.";
    readonly input_schema: {
        readonly type: "object";
        readonly properties: {
            readonly from: {
                readonly type: "string";
                readonly description: "YYYY-MM-DD";
            };
            readonly to: {
                readonly type: "string";
                readonly description: "YYYY-MM-DD";
            };
        };
        readonly required: readonly ["from", "to"];
    };
}, {
    readonly name: "fbs_to_ship";
    readonly description: "Что нужно собрать и отгрузить по FBS и до какого времени (просроченные — штраф), по каждому отправлению.";
    readonly input_schema: {
        readonly type: "object";
        readonly properties: {};
    };
}, {
    readonly name: "purchase_needs";
    readonly description: "Сколько товара и денег по закупочной (оптовой) цене нужно, чтобы собрать ещё не собранные FBS-заказы.";
    readonly input_schema: {
        readonly type: "object";
        readonly properties: {};
    };
}, {
    readonly name: "returns";
    readonly description: "Возвраты Ozon за последние N дней: статус, причина, где сейчас, сумма.";
    readonly input_schema: {
        readonly type: "object";
        readonly properties: {
            readonly days: {
                readonly type: "number";
            };
        };
    };
}, {
    readonly name: "fbo_stock";
    readonly description: "Остатки на складах Ozon (FBO) и на сколько дней хватит; что заканчивается.";
    readonly input_schema: {
        readonly type: "object";
        readonly properties: {};
    };
}];
export declare function runTool(name: string, input: any): Promise<unknown>;
type Block = {
    type: string;
    [k: string]: any;
};
type Msg = {
    role: 'user' | 'assistant';
    content: string | Block[];
};
export declare function setOzonBotFetch(f: typeof fetch | null): void;
export type OzonBotImage = {
    mediaType: string;
    base64: string;
};
/** Ответ на вопрос владельца: Claude сам вызывает инструменты (до 8 шагов) и пишет ответ. Фото товара — для анализа конкурентов. */
export declare function askOzonManager(history: Msg[], question: string, image?: OzonBotImage): Promise<string>;
export {};
