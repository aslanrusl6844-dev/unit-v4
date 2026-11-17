"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.yandexCloudSchema = void 0;
exports.getYandexCloudStore = getYandexCloudStore;
exports.saveYandexCloudStore = saveYandexCloudStore;
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
/** Подключение Yandex Cloud (Wordstat) — по образцу src/handlers/teezStore.ts. */
exports.yandexCloudSchema = zod_1.z.object({
    folderId: zod_1.z.string().trim().min(5, 'Folder ID обязателен (идентификатор каталога в Yandex Cloud)'),
    apiKey: zod_1.z.string().trim().min(10, 'API-ключ обязателен (показывается один раз при создании)'),
}).superRefine((v, ctx) => {
    // Частая ошибка: в поле ключа вставлен ID каталога/облака (b1g…), потому что кнопка «Копировать» не сработала.
    if (v.apiKey === v.folderId || /^b1g[0-9a-z]{15,}$/i.test(v.apiKey)) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            path: ['apiKey'],
            message: 'В поле «API-ключ» вставлен ID каталога (b1g…). Нужен секретный ключ из AI Studio — длинная строка, обычно начинается с AQVN',
        });
    }
});
function present(store) {
    // Ключ целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
    return { ...store, apiKey: undefined, apiKeyMasked: `${store.apiKey.slice(0, 4)}••••${store.apiKey.slice(-4)}` };
}
async function getYandexCloudStore() {
    try {
        const store = await prisma_1.prisma.yandexCloudStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        return store ? present(store) : null;
    }
    catch (err) {
        throw new Error(`Не удалось получить настройки Yandex Cloud: ${String(err?.message ?? err)}`);
    }
}
async function saveYandexCloudStore(body) {
    const parsed = exports.yandexCloudSchema.safeParse(body);
    if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.flatten() } };
    }
    try {
        const existing = await prisma_1.prisma.yandexCloudStore.findFirst({ orderBy: { updatedAt: 'desc' } });
        const store = existing
            ? await prisma_1.prisma.yandexCloudStore.update({ where: { id: existing.id }, data: parsed.data })
            : await prisma_1.prisma.yandexCloudStore.create({ data: parsed.data });
        return { status: 201, body: present(store) };
    }
    catch (err) {
        return { status: 500, body: { error: 'Не удалось сохранить настройки Yandex Cloud', details: String(err?.message ?? err) } };
    }
}
//# sourceMappingURL=yandexCloudStore.js.map