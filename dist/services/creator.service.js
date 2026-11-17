"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CREATOR_DEFAULT_PERCENT = exports.CREATOR_MAX_PERCENT = exports.CREATOR_MIN_PERCENT = void 0;
exports.normalizePercent = normalizePercent;
exports.randomCreatorCode = randomCreatorCode;
exports.uniqueCreatorCode = uniqueCreatorCode;
exports.parseAnswers = parseAnswers;
exports.pushCreator = pushCreator;
exports.approveApplication = approveApplication;
/**
 * Креаторы My Market Live (шаг 1): заявка из приложения («Я креатор» → анкета),
 * одобрение в админке с процентом, личный код креатора.
 * Начисления, шортс и эфиры — следующие шаги.
 */
const crypto_1 = require("crypto");
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const pushBroadcast_service_1 = require("./pushBroadcast.service");
exports.CREATOR_MIN_PERCENT = 1;
exports.CREATOR_MAX_PERCENT = 50;
exports.CREATOR_DEFAULT_PERCENT = 7;
/** Процент креатора: число 1..50 (до 0.5), иначе null. */
function normalizePercent(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n))
        return null;
    const r = Math.round(n * 2) / 2;
    if (r < exports.CREATOR_MIN_PERCENT || r > exports.CREATOR_MAX_PERCENT)
        return null;
    return r;
}
// Без похожих символов (0/O, 1/I/L), чтобы код легко продиктовать.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCreatorCode() {
    let s = '';
    for (let i = 0; i < 5; i += 1)
        s += CODE_ALPHABET[(0, crypto_1.randomInt)(CODE_ALPHABET.length)];
    return `MM-${s}`;
}
async function uniqueCreatorCode() {
    for (let i = 0; i < 20; i += 1) {
        const code = randomCreatorCode();
        const taken = await prisma_1.prisma.creator.findUnique({ where: { code } });
        if (!taken)
            return code;
    }
    throw new Error('Не удалось подобрать свободный код креатора');
}
function parseAnswers(raw) {
    try {
        const v = JSON.parse(raw ?? '{}');
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
}
/** Пуш покупателю-креатору (по телефону). Ошибки не мешают основному действию. */
async function pushCreator(phone, title, body) {
    try {
        const device = await prisma_1.prisma.shopCustomerPushToken.findUnique({ where: { phone } });
        if (!device?.token)
            return;
        await (0, pushBroadcast_service_1.sendBroadcast)({ title, body, tokens: [device.token], data: { type: 'creator' } });
    }
    catch (err) {
        logger_1.logger.warn({ err: String(err?.message ?? err) }, '[Creator] пуш не ушёл');
    }
}
/** Одобрить заявку: создаёт (или обновляет) креатора с процентом и личным кодом. */
async function approveApplication(id, percent) {
    const app = await prisma_1.prisma.creatorApplication.findUnique({ where: { id } });
    if (!app)
        return null;
    const wasApproved = app.status === 'approved';
    await prisma_1.prisma.creatorApplication.update({ where: { id }, data: { status: 'approved', reviewedAt: new Date(), rejectReason: null } });
    const existing = await prisma_1.prisma.creator.findUnique({ where: { phone: app.phone } });
    const creator = existing
        ? await prisma_1.prisma.creator.update({ where: { id: existing.id }, data: { percent, active: true, name: app.name, applicationId: app.id } })
        : await prisma_1.prisma.creator.create({ data: { phone: app.phone, name: app.name, code: await uniqueCreatorCode(), percent, active: true, applicationId: app.id } });
    if (!wasApproved) {
        await pushCreator(app.phone, 'Вы креатор My Market! 🎉', `Заявка одобрена. Ваш код ${creator.code}, процент с продаж — ${percent}%.`);
    }
    return creator;
}
//# sourceMappingURL=creator.service.js.map