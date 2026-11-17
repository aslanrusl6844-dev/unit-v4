"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expensesRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
exports.expensesRouter = (0, express_1.Router)();
const adSpendSchema = zod_1.z.object({
    marketplace: zod_1.z.enum(['KASPI', 'OZON', 'WB', 'TEEZ']),
    date: zod_1.z.string(),
    amount: zod_1.z.number().nonnegative(),
    note: zod_1.z.string().optional(),
});
exports.expensesRouter.get('/ad-spend', async (req, res) => {
    const { from, to } = req.query;
    const where = {};
    if (from || to) {
        where.date = {};
        if (from)
            where.date.gte = new Date(from);
        if (to)
            where.date.lte = new Date(to);
    }
    const items = await prisma_1.prisma.adSpend.findMany({ where, orderBy: { date: 'desc' } });
    res.json(items);
});
exports.expensesRouter.post('/ad-spend', async (req, res) => {
    const parsed = adSpendSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    const item = await prisma_1.prisma.adSpend.create({
        data: { ...parsed.data, date: new Date(parsed.data.date) },
    });
    res.status(201).json(item);
});
exports.expensesRouter.delete('/ad-spend/:id', async (req, res) => {
    try {
        await prisma_1.prisma.adSpend.delete({ where: { id: req.params.id } });
        res.status(204).send();
    }
    catch {
        res.status(404).json({ error: 'Запись не найдена' });
    }
});
const manualExpenseSchema = zod_1.z.object({
    marketplace: zod_1.z.enum(['KASPI', 'OZON', 'WB', 'TEEZ']).optional().nullable(),
    category: zod_1.z.string().min(1),
    date: zod_1.z.string(),
    amount: zod_1.z.number().nonnegative(),
    note: zod_1.z.string().optional(),
});
exports.expensesRouter.get('/manual', async (req, res) => {
    const { from, to } = req.query;
    const where = {};
    if (from || to) {
        where.date = {};
        if (from)
            where.date.gte = new Date(from);
        if (to)
            where.date.lte = new Date(to);
    }
    const items = await prisma_1.prisma.manualExpense.findMany({ where, orderBy: { date: 'desc' } });
    res.json(items);
});
exports.expensesRouter.post('/manual', async (req, res) => {
    const parsed = manualExpenseSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    const item = await prisma_1.prisma.manualExpense.create({
        data: { ...parsed.data, date: new Date(parsed.data.date) },
    });
    res.status(201).json(item);
});
exports.expensesRouter.delete('/manual/:id', async (req, res) => {
    try {
        await prisma_1.prisma.manualExpense.delete({ where: { id: req.params.id } });
        res.status(204).send();
    }
    catch {
        res.status(404).json({ error: 'Запись не найдена' });
    }
});
//# sourceMappingURL=expenses.routes.js.map