export type DeliveryStepState = 'done' | 'now' | 'todo';
export type DeliveryIcon = 'check' | 'rocket' | 'truck' | 'none';
export type DeliveryStep = {
    title: string;
    subtitle: string;
    state: DeliveryStepState;
    icon: DeliveryIcon;
};
export type DeliveryInfo = {
    kind: 'express' | 'intercity' | 'cancelled';
    title: string;
    subtitle: string;
    icon: DeliveryIcon;
    progress: {
        total: number;
        done: number;
        current: number;
    };
    steps: DeliveryStep[];
    note: string | null;
};
export type DeliveryOrderInput = {
    status: string;
    city: string | null;
    createdAt: Date;
    paidAt: Date | null;
    updatedAt: Date;
    deliveredAt: Date | null;
    shippedAt: Date | null;
    arrivedAt: Date | null;
};
export declare function ruDate(d: Date): string;
export declare function ruDateTime(d: Date): string;
/** День, к которому курьер привезёт заказ по Алматы: оплата до 18:00 → завтра, позже → послезавтра; без воскресенья, если так настроено. */
export declare function expressPromiseDate(paidAt: Date): Date;
/**
 * null — для заказов, у которых хода доставки ещё нет (ожидает оплаты).
 * Для отменённого — короткая «карточка» без шагов.
 */
export declare function buildDelivery(o: DeliveryOrderInput, now?: Date): DeliveryInfo | null;
