export declare function rekassaConfigured(): boolean;
export declare function rekassaAuto(): boolean;
export declare function rekassaIsTest(): boolean;
/**
 * Ссылка на чек в ОФД. Касса ещё отдаёт старый адрес *.4ek.kz — re:Kassa просит использовать только
 * ofd-test.rekassa.kz (тест) и ofd.rekassa.kz (бой), страница чека — /portal/.
 */
export declare function ofdReceiptUrl(url: string | null | undefined): string | null;
export declare class RekassaError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status?: number);
}
type FetchFn = typeof fetch;
/** Для тестов: подменить сеть. */
export declare function setRekassaFetch(f: FetchFn | null): void;
/** Тело чека по заказу: товары + доставка отдельной строкой, оплата картой. */
export declare function ticketFor(order: {
    total: number;
    items: string;
}, operation: 'sell' | 'return'): {
    total: number;
    body: {
        operation: string;
        dateTime: {
            date: {
                year: string;
                month: string;
                day: string;
            };
            time: {
                hour: string;
                minute: string;
                second: string;
            };
        };
        domain: {
            type: string;
        };
        items: {
            type: string;
            commodity: {
                name: string;
                sectionCode: string;
                quantity: number;
                price: {
                    bills: string;
                    coins: number;
                };
                sum: {
                    bills: string;
                    coins: number;
                };
                measureUnitCode: string;
                auxiliary: {
                    key: string;
                    value: string;
                }[];
            };
        }[];
        payments: {
            type: string;
            sum: {
                bills: string;
                coins: number;
            };
        }[];
        amounts: {
            total: {
                bills: string;
                coins: number;
            };
            taken: {
                bills: string;
                coins: number;
            };
            change: {
                bills: string;
                coins: number;
            };
        };
    };
};
/**
 * Пробить чек по заказу (продажа или возврат). Один чек на заказ и операцию:
 * повторный вызов после ошибки идёт с тем же X-Request-ID — касса не задвоит чек.
 */
export declare function fiscalizeOrder(orderId: string, operation: 'sell' | 'return'): Promise<any>;
/** Состояние кассы для админки: подключена ли, смена, режим ОФД. */
export declare function rekassaStatus(): Promise<{
    configured: boolean;
    test: boolean;
    auto: boolean;
    ok?: undefined;
    name?: undefined;
    serialNumber?: undefined;
    status?: undefined;
    fdoMode?: undefined;
    shiftOpen?: undefined;
    shiftNumber?: undefined;
    shiftExpireTime?: undefined;
    error?: undefined;
} | {
    configured: boolean;
    test: boolean;
    auto: boolean;
    ok: boolean;
    name: any;
    serialNumber: any;
    status: any;
    fdoMode: any;
    shiftOpen: boolean;
    shiftNumber: any;
    shiftExpireTime: any;
    error?: undefined;
} | {
    configured: boolean;
    test: boolean;
    auto: boolean;
    ok: boolean;
    error: string;
    name?: undefined;
    serialNumber?: undefined;
    status?: undefined;
    fdoMode?: undefined;
    shiftOpen?: undefined;
    shiftNumber?: undefined;
    shiftExpireTime?: undefined;
}>;
/** Закрыть открытую смену (Z-отчёт). Вызывается раз в сутки из крона — смена не должна жить больше 24 ч. */
export declare function closeRekassaShift(): Promise<{
    closed: boolean;
    shiftNumber?: number;
    reason?: string;
}>;
export {};
