"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adsRouter = void 0;
const express_1 = require("express");
const prisma_1 = require("../db/prisma");
exports.adsRouter = (0, express_1.Router)();
/**
 * Статус подключений для страницы «Реклама» и блока Wordstat.
 * Google Ads и Яндекс Директ пока не подключены (нужны аккаунты, доступ к API
 * и токены) — честно показываем «не подключено», а не пустые цифры.
 */
exports.adsRouter.get('/status', async (_req, res) => {
    let wordstat = false;
    try {
        wordstat = Boolean(await prisma_1.prisma.yandexCloudStore.findFirst({ select: { id: true } }));
    }
    catch {
        wordstat = false;
    }
    res.json({
        wordstat: { configured: wordstat },
        googleAds: { configured: false },
        yandexDirect: { configured: false },
    });
});
//# sourceMappingURL=ads.routes.js.map