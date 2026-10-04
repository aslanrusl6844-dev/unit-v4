import { prisma } from '../db/prisma';

/** Радиус полки. Считает сервер, не приложение. */
export const YARD_RADIUS_METERS = 400;

/** Номер магазина и покупателя виден только после «Принял». */
export const YARD_PHONE_VISIBLE_STATUSES = ['accepted', 'at_door', 'done', 'not_picked', 'out_of_stock'];

export class YardTransitionError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'YardTransitionError';
    this.status = status;
  }
}

export function yardDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Покупателю виден только включённый магазин с живой подпиской. */
export function yardShopIsLive(shop: { active: boolean; paidUntil: Date | null }): boolean {
  return shop.active && !!shop.paidUntil && shop.paidUntil.getTime() > Date.now();
}

export async function generateYardPublicId(): Promise<string> {
  const now = new Date();
  const day = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const tail = String(Math.floor(1000 + Math.random() * 9000));
    const publicId = `YD-${day}-${tail}`;
    const existing = await prisma.yardOrder.findUnique({ where: { publicId }, select: { id: true } });
    if (!existing) return publicId;
  }
  throw new YardTransitionError('Не удалось выдать номер заказа', 500);
}

async function loadOrder(orderId: string) {
  const order = await prisma.yardOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) throw new YardTransitionError('Заказ не найден', 404);
  return order;
}

/** «Оплата есть» списывает полку. «Оплаты нет» гасит заказ и остаток не трогает. */
export async function yardApplyPayment(orderId: string, ok: boolean) {
  const order = await loadOrder(orderId);
  if (order.status !== 'waiting_payment') {
    throw new YardTransitionError('Оплату можно отметить только у заказа, который ждёт оплату');
  }
  if (!ok) {
    return prisma.yardOrder.update({ where: { id: orderId }, data: { status: 'no_payment' }, include: { items: true } });
  }
  return prisma.$transaction(async (tx) => {
    for (const line of order.items) {
      if (!line.itemId) continue;
      const item = await tx.yardItem.findUnique({ where: { id: line.itemId } });
      if (!item || item.stock < line.qty) {
        throw new YardTransitionError(`На полке недостаточно «${line.name}»`);
      }
      await tx.yardItem.update({ where: { id: line.itemId }, data: { stock: { decrement: line.qty } } });
    }
    return tx.yardOrder.update({ where: { id: orderId }, data: { status: 'paid' }, include: { items: true } });
  });
}

/** «Принял» — только после оплаты. С этого момента номер виден второй стороне. */
export async function yardApplyAccept(orderId: string) {
  const order = await loadOrder(orderId);
  if (order.status !== 'paid') throw new YardTransitionError('Принять можно только оплаченный заказ');
  return prisma.yardOrder.update({ where: { id: orderId }, data: { status: 'accepted' }, include: { items: true } });
}

/** «Выдан» не трогает полку. «Не забрали» и «Нет в наличии» возвращают остаток. */
export async function yardApplyClose(orderId: string, status: 'done' | 'not_picked' | 'out_of_stock') {
  const order = await loadOrder(orderId);
  if (order.status !== 'accepted' && order.status !== 'at_door') {
    throw new YardTransitionError('Закрыть можно только принятый заказ');
  }
  if (status === 'not_picked' || status === 'out_of_stock') {
    for (const line of order.items) {
      if (!line.itemId) continue;
      await prisma.yardItem.update({ where: { id: line.itemId }, data: { stock: { increment: line.qty } } });
    }
  }
  return prisma.yardOrder.update({ where: { id: orderId }, data: { status }, include: { items: true } });
}
