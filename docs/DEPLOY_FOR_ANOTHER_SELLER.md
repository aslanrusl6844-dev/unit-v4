# Своя копия админки (только Kaspi и Ozon)

Копия разворачивается полностью на аккаунтах продавца: GitHub (код), Neon (база), Vercel (сервер).

1. GitHub: Fork репозитория `aslanrusl6844-dev/unit-v4` к себе. Обновления — кнопка «Sync fork».
2. Neon: новый проект → Connection string: `DATABASE_URL` (pooled) и `DIRECT_URL` (без pooler).
3. Vercel: Add New → Project → импорт своего форка. Environment Variables (Production):
   - `DATABASE_URL`, `DIRECT_URL` — из Neon
   - `ADMIN_USER`, `ADMIN_PASSWORD` (пароль 12+ символов) — вход в админку
   - `CRON_SECRET` — любая длинная случайная строка
   - `APP_MODE=marketplaces`, `ENABLED_MARKETPLACES=KASPI,OZON`
   Deploy. Таблицы в базе создаются сами при сборке.
4. Админка → Настройки: ключи Kaspi и Ozon.
5. (по желанию) GitHub форка → Settings → Secrets and variables → Actions → Variables: `SITE_URL=https://<проект>.vercel.app`, Actions → включить workflows — цены Ozon каждые 5 минут.
