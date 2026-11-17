"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.taxSettingsSchema = void 0;
exports.getTaxSettings = getTaxSettings;
exports.getTaxRatePct = getTaxRatePct;
exports.saveTaxSettings = saveTaxSettings;
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
/**
 * Ставка налога ИП — по умолчанию 4% (упрощёнка: налог считается от
 * ВЫРУЧКИ, не от прибыли). Одна запись на сервер, настраивается в разделе
 * «Настройки».
 */
exports.taxSettingsSchema = zod_1.z.object({
    ratePct: zod_1.z.number().min(0).max(100),
});
async function getTaxSettings() {
    const settings = await prisma_1.prisma.taxSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
    return { ratePct: settings?.ratePct ?? 4 };
}
/** Только число ставки — для использования внутри analytics.service.ts,
 *  без лишних полей. */
async function getTaxRatePct() {
    const settings = await prisma_1.prisma.taxSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
    return settings?.ratePct ?? 4;
}
async function saveTaxSettings(body) {
    const parsed = exports.taxSettingsSchema.safeParse(body);
    if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.flatten() } };
    }
    try {
        const existing = await prisma_1.prisma.taxSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
        const settings = existing
            ? await prisma_1.prisma.taxSettings.update({ where: { id: existing.id }, data: parsed.data })
            : await prisma_1.prisma.taxSettings.create({ data: parsed.data });
        return { status: 201, body: settings };
    }
    catch (err) {
        return { status: 500, body: { error: 'Не удалось сохранить ставку налога', details: String(err?.message ?? err) } };
    }
}
//# sourceMappingURL=taxSettings.js.map