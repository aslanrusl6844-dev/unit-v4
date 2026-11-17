"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ozonStoreSchema = void 0;
exports.getOzonStore = getOzonStore;
exports.saveOzonStore = saveOzonStore;
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
/** Логика подключения Ozon — по образцу src/handlers/kaspiStore.ts. */
exports.ozonStoreSchema = zod_1.z.object({
    clientId: zod_1.z
        .string()
        .min(1, 'Укажите Client-Id')
        .regex(/^\d+$/, 'Client-Id должен состоять только из цифр (это числовой ID из кабинета Ozon, не email и не название магазина)'),
    apiKey: zod_1.z.string().min(5, 'Api-Key обязателен и должен быть похож на настоящий'),
});
async function getOzonStore() {
    try {
        const store = await prisma_1.prisma.ozonStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        if (!store)
            return null;
        // Api-Key целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
        return { ...store, apiKey: undefined, apiKeyMasked: `••••${store.apiKey.slice(-4)}` };
    }
    catch (err) {
        throw new Error(`Не удалось получить магазин Ozon: ${String(err?.message ?? err)}`);
    }
}
async function saveOzonStore(body) {
    const parsed = exports.ozonStoreSchema.safeParse(body);
    if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.flatten() } };
    }
    try {
        const existing = await prisma_1.prisma.ozonStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        const store = existing
            ? await prisma_1.prisma.ozonStore.update({ where: { id: existing.id }, data: parsed.data })
            : await prisma_1.prisma.ozonStore.create({ data: parsed.data });
        return {
            status: 201,
            body: { ...store, apiKey: undefined, apiKeyMasked: `••••${store.apiKey.slice(-4)}` },
        };
    }
    catch (err) {
        return { status: 500, body: { error: 'Не удалось сохранить магазин Ozon', details: String(err?.message ?? err) } };
    }
}
//# sourceMappingURL=ozonStore.js.map