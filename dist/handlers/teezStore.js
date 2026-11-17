"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.teezStoreSchema = void 0;
exports.getTeezStore = getTeezStore;
exports.saveTeezStore = saveTeezStore;
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const teez_client_1 = require("../integrations/teez.client");
/** Логика подключения Teez — по образцу src/handlers/wbStore.ts / ozonStore.ts. */
exports.teezStoreSchema = zod_1.z.object({
    clientId: zod_1.z.string().trim().min(1, 'Client ID обязателен (виден в таблице «Ключи API» в кабинете Teez)'),
    clientSecret: zod_1.z.string().trim().min(8, 'Ключ API обязателен (не короче 8 символов; показывается один раз при создании)'),
});
function present(store) {
    // Ключ целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
    return { ...store, clientSecret: undefined, clientSecretMasked: `••••${store.clientSecret.slice(-4)}` };
}
async function getTeezStore() {
    try {
        const store = await prisma_1.prisma.teezStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        return store ? present(store) : null;
    }
    catch (err) {
        throw new Error(`Не удалось получить магазин Teez: ${String(err?.message ?? err)}`);
    }
}
async function saveTeezStore(body) {
    const parsed = exports.teezStoreSchema.safeParse(body);
    if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.flatten() } };
    }
    try {
        const existing = await prisma_1.prisma.teezStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        const store = existing
            ? await prisma_1.prisma.teezStore.update({ where: { id: existing.id }, data: parsed.data })
            : await prisma_1.prisma.teezStore.create({ data: parsed.data });
        // Сразу проверяем ключи: получилось ли войти. Сохранение от результата не зависит.
        teez_client_1.teezClient.resetToken();
        const connection = await teez_client_1.teezClient.testConnection(parsed.data);
        return { status: 201, body: { ...present(store), connection } };
    }
    catch (err) {
        return { status: 500, body: { error: 'Не удалось сохранить магазин Teez', details: String(err?.message ?? err) } };
    }
}
//# sourceMappingURL=teezStore.js.map