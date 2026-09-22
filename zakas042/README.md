# Backend — mahalliy ishga tushirish

Bu fayl **mahalliy** (kompyuterda) ishga tushirish uchun.
Kundalik ish serverda olib boriladi — [`../SERVER.md`](../SERVER.md).

Loyiha logikasi: [`../PROJECT_LOGIC.md`](../PROJECT_LOGIC.md)

---

## Talablar

- Node.js 22+
- PostgreSQL 16+ (`btree_gist` kengaytmasi bilan — overbooking
  constraint'i shunga tayanadi)
- Redis 7+

Docker bilan: `docker compose up` — uchala xizmat ko'tariladi.

---

## Sozlash

```bash
cd backend
cp .env.example .env
```

`.env` da to'ldirish **shart** bo'lgan qiymatlar:

| O'zgaruvchi | Nima |
|---|---|
| `DATABASE_URL` | PostgreSQL manzili |
| `REDIS_URL` | Redis manzili |
| `ENCRYPTION_KEY` | Beds24 token'larini shifrlash (32 bayt **hex** = 64 belgi) |
| `JWT_SECRET` | Sessiya imzosi (32+ belgi) |
| `WEBHOOK_URL_TOKEN` | Webhook URL'idagi maxfiy token |

Kalit yasash (**hex**, base64 emas):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Baza

```bash
npm install
npx prisma migrate deploy
npm run db:seed          # 18 xona, 9 tarif, 3285 narx, test foydalanuvchilar
```

**Seed mavjud ma'lumotni o'chiradi.** Ishlatilayotgan bazada
ehtiyot bo'ling.

Seed'dan keyin Beds24 ulanishi va mapping tiklanadi:

```bash
npm run beds24:mock
```

---

## Ishga tushirish

```bash
npm run dev              # backend :3000 (yoki .env dagi PORT)
```

Frontend backendning o'zidan beriladi (`backend/public/app/`),
alohida server kerak emas:

| Manzil | Nima |
|---|---|
| `/` | Sayt |
| `/shaxmatka` | Bandlik jadvali |
| `/admin-panel` | Xodimlar paneli |

Kirish: `founder@imron.local` / `admin12345`

---

## Mock Beds24

Beds24 hisobisiz sinash uchun:

```bash
cd mock-beds24 && npm install && npm run dev   # :4000
```

`.env` da `BEDS24_BASE_URL="http://localhost:4000"`.

Mock 9 room type / 18 xona qaytaradi — PMS inventari bilan
aynan mos (`mock-beds24/fixtures/properties.ts`).

Real Beds24'ga ulash qadamlari: [`../TODO.md`](../TODO.md).

---

## Testlar

```bash
PMS_URL=http://127.0.0.1:3000 MOCK_URL=http://127.0.0.1:4000 npm test
```

**`127.0.0.1` yozing, `localhost` emas.** Node 18+ da
`localhost` avval IPv6 (`::1`) ga hal bo'ladi va SSH tunnel
orqali ishlaganda ulanish rad etiladi.

**Testlar bazani tozalaydi** — har test faylidan oldin seed
chaqiriladi. Ishlatilayotgan bazada ishlatmang.

---

## Buyruqlar

| Buyruq | Nima |
|---|---|
| `npm run dev` | Ishlab chiqish (tsx watch) |
| `npm run build` | TypeScript → `dist/` |
| `npm start` | `dist/server.js` |
| `npm test` | Vitest |
| `npm run db:migrate` | Yangi migratsiya |
| `npm run db:deploy` | Migratsiyalarni qo'llash |
| `npm run db:seed` | Baza to'ldirish |
| `npm run db:studio` | Prisma Studio |
| `npm run beds24:connect` | Real Beds24 ulanishi |
| `npm run beds24:mock` | Mock ulanish + 9 mapping |
| `npm run build:css` | Shaxmatka Tailwind CSS |
