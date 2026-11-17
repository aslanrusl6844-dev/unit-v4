"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.kaspiStoreSchema = void 0;
exports.getKaspiStore = getKaspiStore;
exports.saveKaspiStore = saveKaspiStore;
exports.deleteKaspiStore = deleteKaspiStore;
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
/**
 * Логика вынесена из Express-роута в обычные функции, чтобы её могли
 * использовать ДВА разных входа:
 *  - src/routes/settings.routes.ts — обычный Express-роут (через catch-all
 *    api/[...slug].ts, для локальной разработки и как основной путь);
 *  - api/settings/kaspi-store.ts — ОТДЕЛЬНЫЙ файл-маршрут на Vercel,
 *    страховка на случай проблем с маршрутизацией catch-all для этого
 *    конкретного пути (тот же приём, что уже решил проблему с /api/cron/*).
 */
exports.kaspiStoreSchema = zod_1.z.object({
    name: zod_1.z.string().min(1, 'Укажите название магазина'),
    bin: zod_1.z.string().optional().nullable(),
    contactPhone: zod_1.z.string().optional().nullable(),
    contactEmail: zod_1.z.string().optional().nullable(),
    apiToken: zod_1.z.string().min(10, 'Токен обязателен и должен быть похож на настоящий'),
    merchantUid: zod_1.z.string().optional().nullable(),
});
async function getKaspiStore() {
    try {
        const store = await prisma_1.prisma.kaspiStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        if (!store)
            return null;
        // Токен целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
        return { ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` };
    }
    catch (err) {
        // Не даём ошибке долететь необработанной до вызывающего кода — иначе
        // на Vercel это выглядит как полный крах функции без единой зацепки,
        // вместо понятного сообщения.
        throw new Error(`Не удалось получить магазин: ${String(err?.message ?? err)}`);
    }
}
async function saveKaspiStore(body) {
    const parsed = exports.kaspiStoreSchema.safeParse(body);
    if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.flatten() } };
    }
    try {
        const existing = await prisma_1.prisma.kaspiStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        const store = existing
            ? await prisma_1.prisma.kaspiStore.update({ where: { id: existing.id }, data: parsed.data })
            : await prisma_1.prisma.kaspiStore.create({ data: parsed.data });
        return {
            status: 201,
            body: { ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` },
        };
    }
    catch (err) {
        return { status: 500, body: { error: 'Не удалось сохранить магазин', details: String(err?.message ?? err) } };
    }
}
async function deleteKaspiStore(id) {
    try {
        await prisma_1.prisma.kaspiStore.delete({ where: { id } });
        return { status: 204, body: null };
    }
    catch {
        return { status: 404, body: { error: 'Магазин не найден' } };
    }
}
//# sourceMappingURL=kaspiStore.js.map