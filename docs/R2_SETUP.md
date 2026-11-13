# Cloudflare R2 для видео My Market

Видео из админки (MP4/WEBM: видео товаров и витрин, видео-баннеры) загружаются в бакет
Cloudflare R2 `mymarket-videos`, до **100 МБ**. Браузер отправляет файл **прямо в R2** по
одноразовой ссылке. Через Vercel он не проходит, поэтому его предел 4.5 МБ не мешает.
В базу сохраняется публичная ссылка `https://pub-….r2.dev/<время>-<случайное>-<имя>.mp4`.

Фото загружаются как раньше — в Vercel Blob. Старые файлы в Blob не трогаются: ссылки на них в базе продолжают работать.
Если R2 не настроен, видео тоже идут по-старому в Vercel Blob, до ~3 МБ.

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
| `R2_BUCKET_NAME` | `mymarket-videos` (можно не задавать — это значение по умолчанию) |
| `R2_PUBLIC_URL` | публичный адрес бакета, например `https://pub-xxxxx.r2.dev` (R2 → бакет → Settings → Public Development URL). Можно и без `https://` |

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

- `GET /api/shop/admin/upload-info` (под логином админки) → `"videoStorage": "r2", "directVideo": true, "maxVideoBytes": 104857600`.
- Загрузите видео 10–100 МБ в карточку товара (блок «Видео (до 3)») — в статусе идут проценты, потом «Видео добавлено». Ссылка в карточке начинается с `https://pub-…r2.dev/`.
- В логах Vercel: `[Media] выдана ссылка для прямой загрузки в R2` / `[Media] файл сохранён в R2`
  (или `… в Vercel Blob`, если R2 не настроен).

## Как устроено

- **Загрузка видео:** `POST /api/shop/admin/upload-url` `{ purpose: "video", filename, contentType: "video/mp4", size }` → `{ uploadUrl, url, method: "PUT", headers }`.
  Браузер делает `PUT uploadUrl` с файлом и `Content-Type`. Ссылка действует 10 минут. Только MP4/WEBM, до 100 МБ.
  Без R2 → `501 { reason: "no_r2" }`, и админка грузит видео старым способом.
- `POST /api/shop/admin/upload` (base64, как раньше) — фото в Vercel Blob. Маленькое видео, присланное сюда,
  при настроенном R2 тоже уходит в R2. Предел прежний (~3 МБ) — это предел самого Vercel, его не обойти.
- Публичная ссылка видео: `${R2_PUBLIC_URL}/<время>-<случайное>-<имя файла>`.
- Код: `src/services/mediaStorage.service.ts`, `src/routes/shopMedia.routes.ts`.

Другие места, где пока остаётся Vercel Blob (не входят в эту задачу): черновики товаров
(`productDraft.service.ts`), фото «Двора» (`yard.routes.ts`), фото в отзывах/возвратах
(`shop.routes.ts`) и `shopAdmin.routes.ts`.
