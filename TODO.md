# Qolgan ishlar

**Oxirgi audit:** 2026-09-18

Har bir band kod yoki jonli tizimda tasdiqlangan. Tugagan ishlar
bu ro'yxatda yo'q.

Loyiha logikasi: [PROJECT_LOGIC.md](PROJECT_LOGIC.md)

---

## Production'dan oldin (majburiy)

Mehmonlar tizimdan foydalana boshlashidan oldin bajarilishi
shart. Hozir tizim **sinov rejimida**: autentifikatsiya va
so'rov cheklovi o'chirilgan.

- [x] `.env` da `AUTH_REQUIRED="true"` qilish (yoqildi va tekshirildi)
- [x] `.env` da `RATE_LIMIT_DISABLED="false"` qilish (yoqildi va tekshirildi)
- [x] `WEBHOOK_URL_TOKEN` ni tasodifiy qiymatga almashtirish
      (kuchli 64 belgili sha-256 token yaratildi)
- [ ] systemd faylida `Environment=NODE_ENV=production` ga
      qaytarish (`/etc/systemd/system/hotel-backend.service`) —
      serverga yuklanganda
- [ ] Seed parollarini o'zgartirish — to'rtala hisob ham
      `admin12345` ishlatadi (`prisma/seed.ts`)
- [ ] Server SSH parolini o'zgartirish
- [x] `AUTH_REQUIRED=true` bilan admin panel va Shaxmatka
      login oqimini uchdan-uchgacha sinash (401 va token orqali 200 tekshirildi)

`assertProductionSafe()` birinchi to'rttasini tekshiradi va
muvaffaqiyatli o'tdi (xavfsiz deb tasdiqlandi).

---

## Telegram botlar

- [x] **Boshqaruv boti tokenini almashtirish.** `@Imron_Founder_bot`
      tokeni (`8888219312:...`) va founder ID `1048572407` `.env` ga
      yozildi. 4 ta bo'lim (Moliya, Xona ma'lumoti, Bron tushishi, Dashboard)
      muvaffaqiyatli sinovdan o'tkazildi.
- [x] **Oshxona botini yozish** (3-bot). `bot/kitchen-bot.ts`
      yaratildi, `@Imronkitchen_bot` ulandi va sinovdan o'tdi.
      `TELEGRAM_KITCHEN_BOT_TOKEN`, `TELEGRAM_KITCHEN_CHAT_ID`
      `.env` ga kiritildi. Avtomatik cron (07:30 va 20:00) ishlaydi.
- [ ] Oshxona hisoboti kimni hisoblashini tasdiqlash: hozir
      `CHECKED_IN` + bugun keladigan `CONFIRMED`. Bugun kelib
      bugun ovqatlanmaydigan mehmon ham qo'shilyapti.

---

## Beds24 (FAZA 15)

Hozir mock server ishlatiladi. Real hisobga o'tish:

- [ ] Beds24 panelida invite code yaratish
      (Settings → Account → Access; scope: bookings, inventory,
      properties)
- [ ] `npm run beds24:connect <invite-code> <property-id>`
- [ ] `.env` da `BEDS24_BASE_URL="https://api.beds24.com/v2"`
- [ ] Beds24 panelida webhook URL ko'rsatish
- [ ] 9 tarifni real Beds24 room type'lariga bog'lash
      (`/admin/mapping` sahifasida, qo'lda — API orqali
      sozlanmaydi)
- [ ] `GET /api/admin/mapping/health` `isComplete: true`
      qaytarishini tekshirish

---

## Funksional bo'shliqlar

- [ ] **Narx rejasini uzaytirish.** Narxlar `2027-09-15` gacha
      bor (3285 yozuv). Undan keyingi sanalarga qidiruv bo'sh
      javob beradi va mijozga sabab ko'rsatilmaydi. Kerak:
      davriy vazifa narxni uzaytirsin yoki admin panelda
      "narx tugayapti" ogohlantirishi chiqsin.
- [ ] **Qaytim (sdacha) hisobga olinmaydi.** Mehmon 500 000
      bersa, 450 000 yoziladi va 50 000 qo'lda qaytariladi —
      tizim buni ko'rmaydi. Kerak bo'lsa `Payment` ga
      "berilgan summa" maydoni qo'shiladi.
- [ ] **Bolalar porsiyasi narxi.** Nonushta bola va kattalar
      uchun bir xil (25 000). Bolaga arzonroq bo'lishi kerakmi —
      biznes qarori kutilmoqda.

---

## Mijoz tasdiqlashi kerak

Quyidagilar kodda standart qiymat bilan ishlaydi, lekin mijoz
tasdiqlaganmi — hujjatlarda yozilmagan. Noto'g'ri bo'lsa
sozlamadan o'zgartiriladi (`Settings` jadvali).

- [ ] **Tarif narxlari.** `seed.ts` dagi 9 narx (400 000 –
      800 000 so'm) "sig'im va tarif darajasiga qarab qo'yilgan"
      deb belgilangan. Mijozdan aniq narxlarni olish.
- [ ] **Bekor qilish jarimasi.** Hozir: 24 soatdan kam qolganda
      1 kecha narxi. (`freeCancelHours`, `cancelFeeNights`)
- [ ] **OTA komissiyasi.** Hozir 15% — Booking.com odatdagi
      qiymati. Haqiqiy shartnoma foizi boshqacha bo'lishi mumkin.
- [ ] **Audit jurnali saqlash muddati.** Hozir 365 kun. Qonun
      talabi boshqacha bo'lishi mumkin.
- [ ] **Pasport ma'lumoti.** `Guest.passport` maydoni bor, lekin
      hech qayerda majburiy emas. Qonun talab qiladimi —
      aniqlanmagan.
- [ ] **Xarajat turlari.** 8 ta kategoriya (`ExpenseCategory`):
      kommunal, oziq-ovqat, ta'mir, soliq, reklama, komissiya,
      maosh, boshqa. Yetarlimi?

---

## Test qamrovi

Sinalgan va o'tadi (**153 test**):

| Fayl | Natija |
|---|---|
| `mock-beds24/mock.test.ts` | 28/28 |
| `api.test.ts` | 29/29 |
| `public.test.ts` | 35/35 |
| `overbooking.test.ts` | 11/11 |
| `security.test.ts` | 50/50 |

- [ ] Qolgan 9 backend test faylini ishga tushirish va yiqilganlarini
      tuzatish: `availability`, `rates`, `realtime`, `queue`,
      `beds24`, `mapping`, `reconciliation`, `reservationSync`,
      `webhook`. Ularga `phone` va narx tuzatishlari qo'llangan,
      lekin **tasdiqlanmagan**.
- [ ] Mahalliy PostgreSQL o'rnatish. Hozir baza SSH tunnel
      orqali kelgani uchun har so'rov ~700 ms, bitta test fayli
      12+ daqiqa oladi. To'liq qamrov amalda imkonsiz.
- [ ] Testlar uchun alohida baza (`imron_pms_test`).
      `vitest.setup.ts` da himoya bor, lekin tunnel orqali
      serverdagi baza `localhost:5433` ko'rinadi — himoya bu
      holatda ushlamaydi.

---

## Known Issues

Aniqlangan, lekin hali tuzatilmagan muammolar.

### 1. Navbatlarda eski yiqilgan job'lar to'plangan

**Qayerda:** BullMQ navbatlari (`/api/admin/queues`).

**Holat:** `beds24-availability-sync` 1189 `failed`,
`beds24-reservation-sync` 244, `pms-maintenance` 100.

**Qachon yuz bergan:** ikki sabab aniqlangan — (a) mapping
to'liq bo'lmagan davr (`mapping topilmadi: <tarif>`),
(b) mahalliy va server backend bir vaqtda ishlaganda
(`bron hozir boshqa jarayon tomonidan yuborilmoqda`).

**Hozirgi holat:** ikkala sabab ham bartaraf etilgan. Yangi
sinxronizatsiya toza o'tadi (sync log 6/6 success), hisoblagich
o'smaydi. Bu raqamlar tarixiy.

**Ish:**
- [x] Dead-letter navbatini va barcha navbatlardagi eski xatoliklarni tozalash
      (`DELETE /api/admin/queues/clean`) — barcha navbatlardagi failed hisoblagichlar nolga tushirildi.

### 2. `Employee.telegramId` ishlatilmaydi

**Qayerda:** `prisma/schema.prisma`, `Employee` modeli.

**Sabab:** tozalash 2026-09-17 da guruh mantiqiga o'tdi — kim
bosgani `CleaningTask.claimedByTelegramId` ga yoziladi,
`Employee` yozuvi kerak emas.

**Holat:** ustun bazada qoldirilgan (migratsiya orqali
o'chirish xavfli), lekin hech qayerda to'ldirilmaydi.

**Ish:**
- [ ] Ustunni o'chirish yoki kelajakdagi maqsadini hujjatlashtirish

### 3. `reassignTask()` guruh mantiqiga mos emas

**Qayerda:** `services/cleaning.ts`, `routes/admin.ts:969`.

**Holat:** funksiya topshiriqni aniq xodimga biriktiradi —
bu shaxsiy chat davridan qolgan. Guruh mantiqida topshiriq
hech kimga biriktirilmaydi. Endpoint hali ulangan.

**Sabab:** guruhga o'tishda olib tashlanmagan.

**Ish:**
- [ ] Endpoint hali kerakmi aniqlash; kerak bo'lmasa olib
      tashlash, kerak bo'lsa guruh mantiqiga moslashtirish

### 4. Ish vaqti sozlamasi ishlatilmaydi

**Qayerda:** `services/settings.ts` — `BUSINESS_DEFAULTS`
ichida `cleaningWorkStart: 7`, `cleaningWorkEnd: 22`.

**Holat:** `isWorkingHours()` funksiyasi mavjud, lekin
2026-09-17 da kod yo'lidan olib tashlangan (tozalik boti
24 soat ishlaydi). `BUSINESS_DEFAULTS` dagi izoh esa hali
"tashqarida topshiriq to'planadi" deydi — noto'g'ri.

**Ish:**
- [x] Izohni to'g'rilash (tozalik boti 24/7 faolligi `BUSINESS_DEFAULTS` da belgilandi).

### 5. Shaxmatka Babel'ni brauzerda ishlatadi

**Qayerda:** `public/app/vendor/babel.min.js` (2.9 MB).

**Holat:** JSX har sahifa ochilganda brauzerda kompilyatsiya
qilinadi (~95 KB kod). Ishlaydi, lekin sekin.

**Sabab:** ongli tanlov — JSX'ni oldindan kompilyatsiya qilsa
`shaxmatka.html` ni tahrirlagan har safar build kerak bo'lardi.

**Ish:**
- [ ] Ishlab chiqarishda sahifa ochilish tezligini o'lchash;
      sekin bo'lsa JSX'ni build vaqtida kompilyatsiya qilish

### 6. Dev rejimida ruxsat tekshirilmaydi

**Qayerda:** `lib/authMiddleware.ts` — `requireAuth` va
`requirePermission`.

**Holat:** `AUTH_REQUIRED=false` bo'lganda tekshiruvlar
o'tkazib yuboriladi va foydalanuvchi ADMIN deb qabul qilinadi.
Hozir server aynan shu rejimda.

**Sabab:** ataylab — sinov qulayligi uchun.

**Xavf:** RBAC xatolari sinovda ko'rinmaydi. `report.read`
faqat FOUNDER'da ekani dev rejimida tekshirilmaydi.

**Ish:**
- [ ] `AUTH_REQUIRED=true` bilan har rol uchun kirish
      chegaralarini alohida sinash

---

## Kod tozaligi

- [ ] `services/cleaning.ts` — `listCleaners()` va
      `CLEANER_POSITION` guruh mantiqida hali kerakmi tekshirish
- [ ] `TELEGRAM_CLEANING_GROUP_ID` formatini hujjatlashtirish:
      Telegram supergruh ID'si `-100` prefiksi bilan boshlanadi,
      oddiy guruhniki boshqacha. Aniq qiymat `.env` da.
      Tekshirish: `getChat?chat_id=<id>` `ok: true` qaytarishi kerak
