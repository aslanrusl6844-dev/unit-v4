"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wbStoreSchema = void 0;
exports.getWbStore = getWbStore;
exports.saveWbStore = saveWbStore;
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
/** Логика подключения Wildberries — по образцу src/handlers/ozonStore.ts. */
exports.wbStoreSchema = zod_1.z.object({
    apiToken: zod_1.z.string().min(10, 'API-ключ обязателен и должен быть похож на настоящий (обычно это длинный JWT-токен)'),
});
async function getWbStore() {
    try {
        const store = await prisma_1.prisma.wbStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        if (!store)
            return null;
        // Токен целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
        return { ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` };
    }
    catch (err) {
        throw new Error(`Не удалось получить магазин WB: ${String(err?.message ?? err)}`);
    }
}
async function saveWbStore(body) {
    const parsed = exports.wbStoreSchema.safeParse(body);
    if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.flatten() } };
    }
    try {
        const existing = await prisma_1.prisma.wbStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        const store = existing
            ? await prisma_1.prisma.wbStore.update({ where: { id: existing.id }, data: parsed.data })
            : await prisma_1.prisma.wbStore.create({ data: parsed.data });
        return {
            status: 201,
            body: { ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` },
        };
    }
    catch (err) {
        return { status: 500, body: { error: 'Не удалось сохранить магазин WB', details: String(err?.message ?? err) } };
    }
}
//# sourceMappingURL=wbStore.js.map