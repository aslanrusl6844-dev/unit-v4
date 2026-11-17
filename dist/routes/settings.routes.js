"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsRouter = void 0;
const express_1 = require("express");
const kaspiStore_1 = require("../handlers/kaspiStore");
const ozonStore_1 = require("../handlers/ozonStore");
const wbStore_1 = require("../handlers/wbStore");
const teezStore_1 = require("../handlers/teezStore");
const yandexCloudStore_1 = require("../handlers/yandexCloudStore");
const taxSettings_1 = require("../handlers/taxSettings");
exports.settingsRouter = (0, express_1.Router)();
exports.settingsRouter.get('/kaspi-store', async (_req, res) => {
    res.json(await (0, kaspiStore_1.getKaspiStore)());
});
exports.settingsRouter.post('/kaspi-store', async (req, res) => {
    const result = await (0, kaspiStore_1.saveKaspiStore)(req.body);
    res.status(result.status).json(result.body);
});
exports.settingsRouter.delete('/kaspi-store/:id', async (req, res) => {
    const result = await (0, kaspiStore_1.deleteKaspiStore)(req.params.id);
    if (result.status === 204)
        return res.status(204).send();
    res.status(result.status).json(result.body);
});
exports.settingsRouter.get('/ozon-store', async (_req, res) => {
    res.json(await (0, ozonStore_1.getOzonStore)());
});
exports.settingsRouter.post('/ozon-store', async (req, res) => {
    const result = await (0, ozonStore_1.saveOzonStore)(req.body);
    res.status(result.status).json(result.body);
});
exports.settingsRouter.get('/wb-store', async (_req, res) => {
    res.json(await (0, wbStore_1.getWbStore)());
});
exports.settingsRouter.post('/wb-store', async (req, res) => {
    const result = await (0, wbStore_1.saveWbStore)(req.body);
    res.status(result.status).json(result.body);
});
exports.settingsRouter.get('/yandex-cloud', async (_req, res) => {
    res.json(await (0, yandexCloudStore_1.getYandexCloudStore)());
});
exports.settingsRouter.post('/yandex-cloud', async (req, res) => {
    const result = await (0, yandexCloudStore_1.saveYandexCloudStore)(req.body);
    res.status(result.status).json(result.body);
});
exports.settingsRouter.get('/teez-store', async (_req, res) => {
    res.json(await (0, teezStore_1.getTeezStore)());
});
exports.settingsRouter.post('/teez-store', async (req, res) => {
    const result = await (0, teezStore_1.saveTeezStore)(req.body);
    res.status(result.status).json(result.body);
});
exports.settingsRouter.get('/tax', async (_req, res) => {
    res.json(await (0, taxSettings_1.getTaxSettings)());
});
exports.settingsRouter.post('/tax', async (req, res) => {
    const result = await (0, taxSettings_1.saveTaxSettings)(req.body);
    res.status(result.status).json(result.body);
});
//# sourceMappingURL=settings.routes.js.map