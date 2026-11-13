# Cloudflare R2 для фото и видео My Market

Новые загрузки из админки (фото товаров, видео товаров и витрин, баннеры) идут в бакет
Cloudflare R2. Большие файлы (видео до 50 МБ) браузер отправляет **прямо в R2** по
одноразовой ссылке. Через Vercel они не проходят, поэтому его предел 4.5 МБ не мешает.

Старые файлы в Vercel Blob не трогаются: ссылки на них в базе продолжают работать.
Если R2 не настроен, загрузка идёт по-старому в Vercel Blob, до ~3 МБ.

## 1. Ключ доступа R2

Cloudflare → R2 → **Manage R2 API Tokens** → **Create API token**:
- Permissions: **Object Read & Write**
- Specify bucket: `mymarket-videos`

После создания Cloudflare покажет **Access Key ID** и **Secret Access Key** (секрет — один раз).
Account ID — на странице R2 справа («Account ID»).

## 2. Переменные в Vercel

Vercel → проект `unit-v4` → Settings → Environment Variables (Production):

| Имя | Значение |
|---|---|
| `R2_ACCOUNT_ID` | Account ID из Cloudflare |
| `R2_ACCESS_KEY_ID` | Access Key ID |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key |
| `R2_BUCKET_NAME` | `mymarket-videos` |
| `R2_PUBLIC_URL` | публичный адрес бакета, например `https://pub-xxxxx.r2.dev` (R2 → бакет → Settings → Public Development URL) |

После добавления — **Redeploy** (Deployments → последний → Redeploy), иначе новые
переменные не подхватятся.

Ключи нельзя никому пересылать и вставлять в чат — только в Vercel.

## 3. CORS бакета (обязательно для больших видео)

Браузер загружает файл прямо в R2, поэтому бакет должен разрешать запросы с сайта админки.

Cloudflare → R2 → `mymarket-videos` → Settings → **CORS Policy** → Edit → вставить:

```json
[
  {
    "AllowedOrigins": ["https://unit-v4.vercel.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

Если админка открывается ещё с какого-то адреса (свой домен) — добавьте его в `AllowedOrigins`.

Без CORS админка покажет: «Не удалось отправить файл в Cloudflare R2. Скорее всего, в бакете
не разрешён CORS…».

## Как проверить

- `GET /api/shop/admin/upload-info` (под логином админки) → `"storage": "r2", "direct": true`.
- Загрузите видео 10–30 МБ в карточку товара — в статусе идут проценты, потом «Видео добавлено».
- В логах Vercel: `[Media] выдана ссылка для прямой загрузки в R2` / `[Media] файл сохранён в R2`
  (или `… в Vercel Blob`, если R2 не настроен).

## Как устроено

- `POST /api/shop/admin/upload-url` `{ purpose, filename, contentType, size }` → `{ uploadUrl, url, method: "PUT", headers }`.
  Браузер делает `PUT uploadUrl` с файлом и `Content-Type`. Ссылка действует 10 минут.
  Предел: видео — 50 МБ, картинки — 10 МБ. Без R2 → `501 { reason: "no_r2" }`, и админка грузит старым способом.
- `POST /api/shop/admin/upload` (base64, как раньше) — для небольших файлов. Сохраняет в R2, если он
  настроен, иначе в Vercel Blob. Предел прежний (~3 МБ) — это предел самого Vercel, его не обойти.
- Публичная ссылка: `${R2_PUBLIC_URL}/shop/<image|banner|video>/<время>-<случайное>-<имя файла>`.
- Код: `src/services/mediaStorage.service.ts`, `src/routes/shopMedia.routes.ts`.

Другие места, где пока остаётся Vercel Blob (не входят в эту задачу): черновики товаров
(`productDraft.service.ts`), фото «Двора» (`yard.routes.ts`), фото в отзывах/возвратах
(`shop.routes.ts`) и `shopAdmin.routes.ts`.
