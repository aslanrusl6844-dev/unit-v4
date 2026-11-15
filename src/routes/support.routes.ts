import { Router } from 'express';
import { logger } from '../utils/logger';
import { chatState, closeByCustomer, customerMessage, startChat } from '../services/support.service';

/**
 * Чат с оператором из чата Баурсака. Смонтирован внутри assistantRouter (/api/shop/assistant/support),
 * x-app-key проверяется там. Каждый чат защищён своим токеном: его выдаёт /start, приложение
 * передаёт его в заголовке x-support-token.
 */
export const supportRouter = Router();

// Лимит на IP: 30 запросов в минуту на отправку (опрос новых сообщений не ограничиваем).
const hits = new Map<string, number[]>();
function limited(ip: string, max = 30): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

const tokenOf = (req: any) => String(req.header('x-support-token') ?? '');

supportRouter.post('/start', async (req, res) => {
  if (limited(`start:${req.ip}`, 10)) return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
  try {
    const b = req.body ?? {};
    const chat = await startChat({ phone: b.phone, customerName: b.customerName, pushToken: b.pushToken, question: b.question, history: b.history });
    const state = await chatState(chat.id, chat.token, 0);
    res.json({ ...state, token: chat.token });
  } catch (err) {
    logger.error({ err }, '[Support] /start упал');
    res.status(500).json({ error: 'Не удалось соединить с оператором, попробуйте ещё раз' });
  }
});

supportRouter.get('/:id', async (req, res) => {
  try {
    const state = await chatState(req.params.id, tokenOf(req), Number(req.query.after ?? 0));
    if (!state) return res.status(404).json({ error: 'Чат не найден' });
    res.json(state);
  } catch (err) {
    logger.error({ err }, '[Support] GET упал');
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

supportRouter.post('/:id/messages', async (req, res) => {
  if (limited(`msg:${req.ip}`)) return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
  try {
    const r = await customerMessage(req.params.id, tokenOf(req), req.body?.text);
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    res.json({ message: { id: r.message.id, sender: r.message.sender, text: r.message.text, createdAt: r.message.createdAt } });
  } catch (err) {
    logger.error({ err }, '[Support] сообщение упало');
    res.status(500).json({ error: 'Не удалось отправить, попробуйте ещё раз' });
  }
});

supportRouter.post('/:id/close', async (req, res) => {
  try {
    const ok = await closeByCustomer(req.params.id, tokenOf(req));
    if (!ok) return res.status(404).json({ error: 'Чат не найден' });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[Support] close упал');
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
