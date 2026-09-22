# Imron Hotel PMS — loyiha logikasi

**Bu hujjat loyihaning amaldagi logikasining yagona referensi.**

Har bir fakt kod, `schema.prisma` yoki jonli tizimda tasdiqlangan
(2026-09-18). Tasdiqlanmagan narsalar "noaniq" deb belgilangan.

Qolgan ishlar: [TODO.md](TODO.md)

---

## 1. Loyiha nima qiladi

Mehmonxona boshqaruv tizimi (PMS). Bir vaqtda to'rtta ish:

1. **Sayt** — mehmon xona qidiradi va bron qiladi
2. **Shaxmatka** — xodim bandlik jadvalini ko'radi va boshqaradi
3. **Admin panel** — bron, narx, tozalik, moliya, hisobot
4. **Beds24** — Booking.com / Airbnb / Expedia bilan ikki tomonlama
   sinxronizatsiya

Asosiy talab: **overbooking bo'lmasligi shart**. Bir xonaga
kesishuvchi ikki bron hech qanday yo'l bilan tushmasligi kerak.

---

## 2. Arxitektura

```
Booking.com / Airbnb / Expedia
            ↕
         Beds24  (sertifikatlangan channel manager)
            ↕  API v2 + Webhook
      PMS Backend  ←→  PostgreSQL   ← yagona haqiqat manbai
       (Express)        + Redis (BullMQ navbatlari)
            ↕  WebSocket
   Sayt · Shaxmatka · Admin panel
```

**Texnologiyalar:** Node.js 22+, Express, TypeScript, Prisma,
PostgreSQL 16 (`btree_gist` kerak), Redis 7, BullMQ, grammy
(Telegram), Zod (validatsiya), JWT.

**Joylashuv:** butun infratuzilma Contabo VPS'da. Kompyuterda
faqat kod. Ulanish SSH tunnel orqali.

### Qatlamlar

| Qatlam | Papka | Javobgarlik |
|---|---|---|
| Route | `src/routes/` | HTTP, validatsiya (Zod), auth |
| Servis | `src/services/` | Biznes mantiq, tranzaksiyalar |
| Navbat | `src/queues/` | BullMQ worker'lar, davriy vazifalar |
| Realtime | `src/realtime/` | WebSocket push |
| Bot | `src/bot/` | Telegram (ikki alohida bot) |

**Qat'iy qoida:** servis qatlami Telegram'ni, HTTP'ni yoki
WebSocket'ni bilmaydi. U callback chaqiradi (`onTaskChanged`),
bot o'zini shunga ulaydi. Shu sabab bot o'chirilgan bo'lsa ham
tizim ishlayveradi.

### Frontend

Uchala sahifa backend ichida (`backend/public/app/`) va o'sha
serverdan beriladi — CORS va port muammosi yo'q.

| Fayl | Manzil | Texnologiya |
|---|---|---|
| `index.html` | `/` | Vanilla JS |
| `shaxmatka.html` | `/shaxmatka` | React 18 + Tailwind (UMD) |
| `admin-panel.html` | `/admin-panel` | Vanilla JS |

Shaxmatka kutubxonalari `public/app/vendor/` da — CDN'ga
bog'liqlik yo'q, internetsiz ishlaydi. Tailwind CSS oldindan
yasaladi: `npm run build:css`.

---

## 3. Ma'lumot modeli

23 model. Asosiylari:

```
Floor (F1,F2,F3) ──< Room (101..306) >── RoomType (9 tarif)
                       │                      │
                       │                      ├──< RatePlan (kun × tarif × narx)
                       │                      └──< Availability (kesh)
                       │
                       ├──< Reservation >── Guest
                       │       │
                       │       ├──< Payment
                       │       └──< Charge
                       │
                       ├──< RoomDayStatus (yopiq kunlar)
                       └──< CleaningTask

Channel (beds24) ──< ChannelMapping (RoomType ↔ Beds24 roomId)
                 └──< ChannelConnection (shifrlangan token)
```

### Inventar (seed'da belgilangan)

**18 xona, 3 qavat, 9 tarif.** Valyuta **UZS**.

| Tarif | Narx (so'm) | Sig'im | Xonalar |
|---|---|---|---|
| `standard3` | 400 000 | 3 | 102 |
| `comfort3` | 450 000 | 3 | 101, 202, 302 |
| `semilux` | 500 000 | 3 | 105, 305 |
| `comfort4` | 550 000 | 4 | 103, 304 |
| `premium4` | 600 000 | 4 | 104, 203, 204, 303 |
| `deluxe4` | 650 000 | 4 | 106, 206, 306 |
| `famdeluxe` | 700 000 | 3 | 205 |
| `famlux201` | 800 000 | 4 | 201 |
| `famlux301` | 800 000 | 3 | 301 |

`Room.id` = xona raqami (`"101"`). Qavat ID: `F1`, `F2`, `F3`.

Manba: `prisma/seed.ts`.

---

## 4. Overbooking himoyasi — uch qatlam

Loyihaning eng muhim qoidasi. Uch mustaqil to'siq:

**1-qatlam — PostgreSQL constraint** (`reservation_no_overlap`):

```sql
EXCLUDE USING gist (
  "roomId" WITH =,
  daterange("checkIn", "checkOut", '[)') WITH &&
) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'))
```

Bu oxirgi himoya. Hech qanday kod yo'li uni chetlab o'tolmaydi.
Migratsiya: `20260912114500_overbooking_guard`.

**2-qatlam — `isRoomFree()`** tekshiruvi tranzaksiya ichida.
Tushunarli xato berish uchun (409 `ROOM_UNAVAILABLE`).

**3-qatlam — `Availability` keshi** saytda bo'sh xona sonini
ko'rsatadi.

### Serializable tranzaksiya + qayta urinish

`serializableTx()` (`lib/tx.ts`) — 5 urinish, exponential
backoff. Muhim farq:

| Xato | Nima qilinadi |
|---|---|
| `40001` / `P2034` serializatsiya konflikti | **qayta urinish** |
| `23P01` overbooking constraint | **darhol rad etish** |

Ikkinchisiga hech qachon qayta urinilmaydi — u haqiqiy band xona.

### Underbooking himoyasi (teskari tomoni)

`pickRoom()` tranzaksiyadan tashqarida ishlaydi va parallel
so'rovlarga bir xil xonani berardi. `createPublicBooking` endi
band chiqqan xonani `skip` ro'yxatiga qo'shib navbatdagisini
tanlaydi (10 urinishgacha).

Tasdiqlangan: 2 bo'sh xonaga 6 parallel so'rov → **2 bron o'tadi**,
4 tasi 409 oladi.

---

## 5. Bron oqimi

### Manbalar

| Manba | Endpoint | Auth | Ovqat |
|---|---|---|---|
| Sayt | `POST /api/public/reservations` | yo'q | **har doim bor** |
| Qabulxona | `POST /api/reservations` | JWT | xodim tanlaydi |
| Beds24 / OTA | webhook | token | mapping belgilaydi |

### Sayt oqimi

```
Mehmon qidiradi → GET /api/public/availability
      ↓  (narx + nonushta bir summada ko'rsatiladi)
POST /api/public/reservations
      ↓  pickRoom() — eng mos bo'sh xona tanlanadi
createReservation() — Serializable tranzaksiya
      ↓  EXCLUDE constraint tekshiradi
PostgreSQL ← bron yoziladi (PENDING_PAYMENT)
      ↓
WebSocket → Shaxmatka darhol ko'radi
      ↓
Availability kamayadi
      ↓
BullMQ → Beds24 → OTA kanallari
```

**Qoida:** saytdan kelgan bron **har doim ovqat bilan**
(`withMeal: true`). Qidiruv va bron bir xil summa qaytarishi
shart — aks holda mehmon boshqa narx ko'radi.

### Bron kodi

`IMR-XXXXX` — `crypto.randomInt` bilan, ketma-ket emas.
Chalkashadigan belgilar (0/O, 1/I) alifbodan chiqarilgan.
Mehmon `GET /api/public/reservations/:code` bilan ko'radi.

---

## 6. Statuslar

### Bron statuslari va o'tishlar

```
PENDING_PAYMENT → CONFIRMED | CANCELLED | NO_SHOW
CONFIRMED       → CHECKED_IN | CANCELLED | NO_SHOW
CHECKED_IN      → CHECKED_OUT
CHECKED_OUT     → (oxirgi)
CANCELLED       → (oxirgi)
NO_SHOW         → (oxirgi)
```

Boshqa har qanday o'tish rad etiladi (`ALLOWED_TRANSITIONS`,
`services/reservations.ts`). Masalan `CHECKED_OUT` bronni bekor
qilib bo'lmaydi.

### Xona statuslari

`AVAILABLE`, `RESERVED`, `OCCUPIED`, `DIRTY`, `OUT_OF_ORDER`,
`OUT_OF_SERVICE`.

`Room.status` — xonaning **joriy jismoniy holati**, sanaga
bog'liq emas. Kelajakdagi bron unga ta'sir qilmaydi.

Ustuvorlik (yuqoridan pastga): bugun `CHECKED_IN` bron bor →
`OCCUPIED`; bugun `CHECKED_OUT` → `DIRTY`; bugun boshlanadigan
`CONFIRMED`/`PENDING_PAYMENT` → `RESERVED`.

---

## 7. Biznes qoidalari (kodda majburlanadi)

| Qoida | Xatti-harakat | Joyi |
|---|---|---|
| To'lov qarzdan oshmaydi | 400 xato, qarz va kiritilgan summa ko'rsatiladi | `addPayment()` |
| Qaytarish to'langandan oshmaydi | Balans manfiyga tushmaydi | `addPayment()` |
| Status o'tishlari | Faqat ruxsat etilgan yo'nalish | `ALLOWED_TRANSITIONS` |
| Tarifdan past narx | Chegirma sababi talab qilinadi (`priceReason`) | `assertPriceOk()` |
| Narx chegarasi | 1 mln → 50 mln (bayram narxi sig'sin) | Zod sxema |
| Mehmon ismi | Bir xil telefonda ism yangilanadi | `findOrCreateGuest()` |
| Telefon majburiy | Telefonsiz bron har safar yangi mehmon yozuvi yaratardi | `phoneSchema` |
| O'tmish bronlari | 30 kungacha ruxsat, undan oldin rad | `createReservation()` |
| Iflos xona | Tozalanmaguncha check-in yo'q | `checkIn()` |
| To'lov egasi | Kim qabul qilgani yoziladi (`Payment.userId`) | `addPayment()` |
| Bir yildan uzoq bron | Rad etiladi | `validateRange()` |
| Spam himoyasi | Bir telefonga 24 soatda 3 ta to'lanmagan bron | `checkSpam()` |

### Sozlanadigan qiymatlar (`BUSINESS_DEFAULTS`)

| Sozlama | Standart |
|---|---|
| Nonushta narxi | 25 000 so'm / kishi / kecha |
| Bepul bekor qilish | 24 soat |
| Bekor qilish jarimasi | 1 kecha narxi |
| OTA komissiyasi | 15% |
| Audit jurnali saqlash | 365 kun |
| Tozalash me'yori | 30 daqiqa |
| Kechikish eslatmasi | 30 daqiqa |

Bazadagi `Settings` jadvalidan o'zgartiriladi.

---

## 8. Ruxsatlar (RBAC)

To'rt rol. Matritsa `services/auth.ts` da, backend har so'rovda
tekshiradi.

| Huquq | FOUNDER | ADMIN | MANAGER | STAFF |
|---|:---:|:---:|:---:|:---:|
| `report.read` (umumiy hisobot) | ✓ | | | |
| `user.manage` | ✓ | | | |
| `employee.read` / `employee.write` | ✓ | ✓ | | |
| `channel.connect` | ✓ | ✓ | | |
| `mapping.write` | ✓ | ✓ | | |
| `settings.write` | ✓ | ✓ | | |
| `reservation.write` / `.cancel` | ✓ | ✓ | ✓ | |
| `rate.write` | ✓ | ✓ | ✓ | |
| `room.block` | ✓ | ✓ | ✓ | |
| `synclog.read` | ✓ | ✓ | ✓ | |
| `checkin.write` | ✓ | ✓ | ✓ | ✓ |
| `payment.write` | ✓ | ✓ | ✓ | ✓ |
| `reservation.read` | ✓ | ✓ | ✓ | ✓ |

**Muhim:** moliya va foydalanuvchi boshqaruvi faqat FOUNDER'da.
ADMIN texnik ishlarni qiladi, biznes raqamlarini ko'rmaydi.

Frontend `display:none` qiladi, lekin bu faqat ko'rinish —
haqiqiy himoya backendda.

### Autentifikatsiya

JWT, 12 soat. `POST /api/auth/login` → token → `Authorization:
Bearer`. Parollar bcrypt (cost 10). Shaxmatka va admin panel
**bir xil tokenni** ishlatadi.

`AUTH_REQUIRED=false` (dev) bo'lganda tekshiruvlar o'chiriladi va
foydalanuvchi ADMIN deb qabul qilinadi. Production'da
`assertProductionSafe()` bunday ishga tushirishni bloklaydi.

---

## 9. Beds24 integratsiyasi

### Ikki yo'nalish

**Beds24 → PMS (webhook):** `POST /api/webhooks/beds24/:token`
→ `WebhookEvent` saqlanadi → BullMQ navbat → `webhookProcessor`
→ bron yaratiladi/yangilanadi.

**PMS → Beds24 (navbat):** bron o'zgarsa `onReservationChanged`
→ BullMQ → `reservationSync` / `availability` / `rates`.

### Mapping

`ChannelMapping` PMS tarifini Beds24 room type'ga bog'laydi.
Beds24 tomonida mapping **API orqali sozlanmaydi** — faqat
ularning panelida qo'lda.

`GET /api/admin/mapping/health` to'liqlikni tekshiradi: har
tarif bog'langanmi, xona sonlari mos kelyaptimi.

**Hozir mock server ishlatiladi** (`mock-beds24/`), 9 room type
/ 18 xona, PMS bilan aynan mos. Real hisobga o'tishda faqat
`fixtures/properties.ts` o'rniga real API javobi keladi.

### Echo loop himoyasi

Biz yuborgan bron webhook orqali qaytib kelishi mumkin. Ikki
shart bilan aniqlanadi: `referer === "PMS"` **va** `externalId`
bazada allaqachon bor. Faqat birinchi shartga tayanilsa OTA'dan
kelgan yangi bron jimgina yo'qolardi.

### Kredit cheklovi

Beds24 API kredit sarflaydi (100 / 5 daqiqa). Kredit tugasa job
kechiktiriladi — bu xato emas, kutilgan xatti-harakat.

---

## 10. Tozalash tizimi

### Oqim

```
Mehmon chiqdi (check-out) yoki admin panelda "+ Yangi so'rov"
      ↓
CleaningTask (NEW) yaratiladi
      ↓
Telegram GURUHIGA xabar + [🙋 Men olaman]
      ↓
Farosh bosdi → IN_PROGRESS, kim olgani yoziladi
      ↓
[🧹 Tozaladim] → PENDING   ← xona HALI SOTILMAYDI
      ↓
Admin panel → Tozalik → [✓ Tasdiqlash]
      ↓
DONE → xona DIRTY bo'lsa AVAILABLE ga o'tadi
```

### Qoidalar

| Qoida | Sabab |
|---|---|
| Topshiriq hech kimga biriktirilmaydi | Guruhda kim bo'sh bo'lsa oladi |
| Birinchi bosgan oladi | `updateMany` + `status: NEW` — bitta SQL amali |
| Faqat olgan odam tugata oladi | Hisobot to'g'ri bo'lsin |
| Admin tasdiqlashi shart | Tozalash sifati tekshirilsin |
| Vaqt cheklovi yo'q (24 soat) | Mehmonxona kechayu kunduz ishlaydi |
| Bir xona = bir ochiq topshiriq | Takroriy xabar bo'lmasin |

Kim bosgani Telegram ismi bilan yoziladi (`claimedByName`) —
`Employee` yozuvi shart emas.

### Uch alohida bot

| Bot | Auditoriya | Ko'radi |
|---|---|---|
| `bot/index.ts` | Egasi, menejer | Moliya, bronlar, dashboard |
| `bot/cleaning-bot.ts` | Farroshlar guruhi | Faqat tozalash topshiriqlari |
| `bot/kitchen-bot.ts` | Oshpazlar / Oshxona | Nonushta porsiyalari, xonalar ro'yxati |

**Nega alohida:** farosh mehmonxona moliyasini ko'rmasligi, oshpaz esa faqat oshxona porsiyalarini ko'rishi kerak. Bitta token sizib ketsa ham boshqa auditoriyalar himoyalangan qoladi.

Bot ishga tushmasa (token bo'sh) jim o'chadi — backend ishlayveradi.

---

## 11. Oshxona

`services/kitchen.ts` bugun va ertaga nechta porsiya kerakligini
hisoblaydi.

Kim hisoblanadi: `CHECKED_IN` (hozir xonada) + `CONFIRMED`
(bugun keladigan), faqat `withMeal = true`.

Kattalar va bolalar alohida ko'rsatiladi. Admin panel → Oshxona
bo'limida jonli ko'rinadi.

---

## 12. Real-time (WebSocket)

`ws://<host>/ws` — HTTP server ustiga o'rnatilgan, alohida port
kerak emas.

Hodisalar: bron yaratildi/o'zgardi/bekor qilindi, xona holati,
availability o'zgardi, tozalash topshirig'i.

Redis Pub/Sub orqali — bir necha server nusxasi bo'lsa ham
hamma mijozga yetadi.

---

## 13. Navbatlar (BullMQ)

| Navbat | Vazifa |
|---|---|
| `beds24-webhook` | Kelgan webhook'larni qayta ishlash |
| `beds24-reservation-sync` | Bronni Beds24'ga yuborish |
| `beds24-availability-sync` | Bo'sh xona sonini yuborish |
| `beds24-rate-sync` | Narxlarni yuborish |
| `beds24-retry` | Yiqilgan job'lar (dead letter) |
| `pms-maintenance` | Davriy vazifalar |

### Davriy vazifalar

| Vazifa | Davr |
|---|---|
| To'lanmagan bronlarni tozalash | soatlik |
| Beds24 polling + catch-up | 15 daqiqa |
| Drift tekshiruvi | kunlik |
| Tozalash tekshiruvi | 10 daqiqa |

**Qoida:** Redis o'chsa PMS ishlashda davom etadi. Webhook'lar
bazada `QUEUED` holatida to'planadi, Redis qaytganda yuboriladi.
`/health` "degraded" qaytaradi, "down" emas.

---

## 14. Xavfsizlik

| Himoya | Qanday |
|---|---|
| Parollar | bcrypt (cost 10) |
| Token | JWT 12 soat |
| Beds24 refreshToken | AES-256 shifrlangan (`ENCRYPTION_KEY`) |
| Webhook | URL token yoki HMAC imzo |
| CORS | Faqat `CORS_ORIGINS` ro'yxatidagi domenlar |
| Rate limit | IP bo'yicha (`express-rate-limit`) |
| XSS | Admin panelda `esc()`, Shaxmatka React (JSX o'zi escape qiladi) |
| SQL injection | Prisma + Zod validatsiya |
| Bot spam | Honeypot maydoni saytdagi formada |
| Loglar | `sanitizeForLog()` token/parol/karta raqamini `[REDACTED]` qiladi |
| Audit | `AuditLog` — kim, nima, qachon, qaysi IP |

### Production tekshiruvi

`assertProductionSafe()` (`lib/config.ts`) `NODE_ENV=production`
bo'lganda oltita shartni tekshiradi va xavfsiz bo'lmagan
sozlama bilan serverni **ishga tushirmaydi**:

- `AUTH_REQUIRED` yoqilganmi
- `RATE_LIMIT_DISABLED` o'chirilganmi
- `WEBHOOK_URL_TOKEN` dev qiymatida qolmaganmi
- `JWT_SECRET` 32+ belgimi
- `ENCRYPTION_KEY` 32+ belgimi

---

## 15. API kontrakti

85 endpoint. Asosiy guruhlar:

| Prefiks | Auth | Nima |
|---|---|---|
| `/api/public/*` | yo'q | Sayt: tarif ro'yxati, qidiruv, bron, bron holati |
| `/api/auth/*` | qisman | Login, `/me` |
| `/api/rooms/*` | JWT | Xonalar, turlar, bo'sh xonalar, yopish |
| `/api/reservations/*` | JWT | Bron CRUD, status, to'lov |
| `/api/rate-plans` | JWT | Narxlar |
| `/api/admin/*` | JWT + huquq | Mapping, sozlama, tozalik, oshxona, xodim, xarajat, hisobot |
| `/api/webhooks/beds24` | token | Beds24 webhook |

### Xato javoblari

Barcha xatolar bir xil shaklda:

```json
{ "error": "O'zbekcha tushunarli xabar", "code": "VALIDATION" }
```

Kodlar: `VALIDATION` (400), `UNAUTHORIZED` (401), `FORBIDDEN`
(403), `NOT_FOUND` (404), `ROOM_UNAVAILABLE` (409),
`CONCURRENT_CONFLICT` (409), `DUPLICATE_RESERVATION` (409),
`BAD_JSON` (400), `INTERNAL` (500).

---

## 16. Muhit

### Portlar

| Xizmat | Server | Tunnel orqali |
|---|---|---|
| Backend | 3100 | `localhost:3100` |
| Mock Beds24 | 4100 | `localhost:4100` |
| PostgreSQL | 5433 | `localhost:5433` |
| Redis | 6380 | `localhost:6380` |

Server portlari `127.0.0.1` ga bog'langan — internetdan kirib
bo'lmaydi. SSH tunnel yagona yo'l: `bash tools/tunnel.sh`.

### Muhim tuzoqlar

**`localhost` IPv6 ga hal bo'ladi.** Node 18+ da `localhost`
avval `::1` ga hal bo'ladi, SSH tunnel esa IPv4'da tinglaydi.
Test va skriptlarda **`127.0.0.1`** yozish shart.

**Testlar bazani tozalaydi.** `vitest.setup.ts` har test
faylidan oldin `prisma/seed.ts` chaqiradi — barcha bronlar,
narxlar, mapping o'chadi. Ishlatilayotgan bazada test
ishlatmang. Tiklash: `npx tsx prisma/seed.ts` va keyin
`npm run beds24:mock`.

**Bot bir vaqtda bitta joyda.** Mahalliy va server birga ishga
tushsa Telegram `409 Conflict` beradi.

**PostgreSQL 5433.** Mahalliy PostgreSQL 16 xizmati 5432 ni
egallagan; Docker konteyneri 5433 ga chiqariladi.

### Buyruqlar

```bash
npm run dev            # ishlab chiqish (tsx watch)
npm run build          # TypeScript → dist/
npm start              # dist/server.js
npm test               # vitest
npm run db:migrate     # migratsiya
npm run db:seed        # baza to'ldirish
npm run beds24:mock    # mock ulanish + 9 mapping (seed'dan keyin)
npm run build:css      # Shaxmatka Tailwind CSS
```

---

## 17. Noaniq joylar

Kod bilan tasdiqlab bo'lmagan yoki qarama-qarshi ma'lumotlar:

**Narxlar taxminiy.** `seed.ts` dagi 9 tarif narxi hujjatlarda
"sig'im va tarif darajasiga qarab qo'yilgan" deb belgilangan.
Mijoz aniq narxlarni tasdiqlaganmi — noma'lum.

**Ish vaqti sozlamasi ishlatilmaydi.** `BUSINESS_DEFAULTS` da
`cleaningWorkStart: 7`, `cleaningWorkEnd: 22` bor va izohda
"tashqarida topshiriq to'planadi" deyilgan, lekin
`isWorkingHours()` 2026-09-17 da kod yo'lidan olib tashlangan
(bot 24 soat ishlaydi). Sozlama kelajak uchun qoldirilgan.

**Bolalar porsiyasi.** Nonushta narxi bola va kattalar uchun
bir xil (25 000). Bola uchun arzonroq bo'lishi kerakmi —
hal qilinmagan.

**Qaytim (sdacha).** Mehmon 500 000 bersa, 450 000 yoziladi va
50 000 qo'lda qaytariladi. Tizim buni ko'rmaydi.
