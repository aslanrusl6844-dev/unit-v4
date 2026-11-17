"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nichesRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const niche_service_1 = require("../services/niche.service");
const logger_1 = require("../utils/logger");
exports.nichesRouter = (0, express_1.Router)();
const analyzeSchema = zod_1.z.object({
    input: zod_1.z.string().min(3, 'Вставьте ссылку на товар Kaspi или артикул'),
});
exports.nichesRouter.post('/analyze', async (req, res) => {
    const parsed = analyzeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    try {
        const result = await (0, niche_service_1.analyzeNiche)(parsed.data.input);
        res.json(result);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Ниши] Ошибка анализа');
        res.status(500).json({ error: 'Не удалось проанализировать нишу', details: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=niches.routes.js.map