# ASL TZ — IMRON HOTEL PMS × BEDS24 TO'LIQ INTEGRATSIYA

> **MIJOZNING ASL TOPSHIRIG'I — o'zgartirilmagan.**
>
> Bu hujjat biznes talabining manbasi. Tizim shu asosda
> qurilgan, lekin **amaldagi holat undan farq qiladi**:
> ish davomida yangi talablar qo'shilgan (FOUNDER roli,
> tozalik tizimi, oshxona, nonushta tarifi).
>
> **Hozir nima ishlayotgani:** [`../PROJECT_LOGIC.md`](../PROJECT_LOGIC.md)
>
> Texnik yoyilma hujjatlari (`00`–`13`) 2026-09-18 da o'chirildi —
> ular kod bilan zid bo'lib qolgan edi. Muhim qoidalar
> `PROJECT_LOGIC.md` ga ko'chirilib, kod bilan tasdiqlangan.

---

**MUHIM:**
Admin Panel, Customer Website va mavjud Shaxmatka allaqachon yaratilgan.
Ularni qayta yasamang.
Faqat backend + database + Beds24 integratsiyasini mavjud frontendlarga moslab qiling.

**ASOSIY ARXITEKTURA:**

```
Booking.com
Airbnb
Expedia
      ↓
    Beds24
      ↕️ API / Webhook
   PMS Backend
      ↕️
 PostgreSQL Database
      ↕️
 Mavjud Shaxmatka
      ↕️
Admin Panel / Website
```

---

## 1. BEDS24DAN PMSGA MA'LUMOT KELISHI

Beds24 dan quyidagilar PMSga olinishi kerak:

- yangi bron
- bron o'zgarishi
- bron bekor qilinishi
- mehmon ma'lumotlari
- check-in
- check-out
- kattalar soni
- bolalar soni
- xona turi
- xona
- kelish sanasi
- ketish sanasi
- narx
- valyuta
- to'lov ma'lumotlari
- bron manbasi
- Beds24 booking ID

Kelgan ma'lumot PostgreSQL database'ga yoziladi.

Keyin mavjud Shaxmatkada avtomatik ko'rinadi.

---

## 2. SHAXMATKA → BEDS24

Shaxmatkada admin:

- yangi bron yaratsa
- bronni o'zgartirsa
- xonani almashtirsa
- sanani o'zgartirsa
- mehmon sonini o'zgartirsa
- narxni o'zgartirsa
- bronni bekor qilsa
- check-in/check-out qilsa

tegishli ma'lumot Beds24 bilan sinxronlashtiriladi.

---

## 3. WEBSITE → PMS → BEDS24

Saytdan mijoz xona bron qilsa:

```
Website
 ↓
PMS Backend
 ↓
Database
 ↓
Shaxmatka
 ↓
Beds24
 ↓
OTA kanallari
```

Bron qilingan xona boshqa kanallarda mavjud bo'lmagan holatga o'tishi kerak.

**OVERBOOKING BO'LMASLIGI SHART.**

---

## 4. OTA → BEDS24 → PMS

Masalan Booking.com'dan bron keldi:

```
Booking.com
 ↓
Beds24
 ↓
Webhook/API
 ↓
PMS Backend
 ↓
Database
 ↓
Shaxmatka
```

Shaxmatkada bron avtomatik paydo bo'ladi.

Admin sahifani refresh qilmasdan ham yangi bronni ko'rishi uchun WebSocket/real-time update ishlatilsin.

---

## 5. XONA MAPPING

Eng muhim qism.

PMSdagi:

```
RoomType
Room
```

Beds24dagi:

```
Room Type / Room
```

bilan mapping qilinadi.

Masalan:

```
PMS:
Deluxe → Room 202

Beds24:
Deluxe → tegishli Beds24 room/unit
```

Har bir mapping database'da saqlansin.

Noto'g'ri xona turiga bron tushmasligi kerak.

---

## 6. AVAILABILITY SYNC

PMSdagi xona band bo'lsa:

```
PMS
 ↓
Beds24
 ↓
Booking.com / Airbnb / Expedia
```

availability kamayadi.

Xona bo'shatilsa availability qayta oshadi.

Har bir o'zgarish queue orqali yuborilsin.

Temporary API xatosi PMS ishini to'xtatmasin.

---

## 7. RATES SYNC

PMSda xona narxi o'zgarsa:

```
PMS
 ↓
Beds24
 ↓
OTA
```

Narxlar sinxronlashtirilsin.

Agar Beds24dan narx o'zgarsa, PMSga ham update kelishi kerak.

Qaysi tizim source-of-truth ekani konfiguratsiyada aniq belgilanadi.

---

## 8. RESERVATION STATUS

Quyidagi statuslar qo'llab-quvvatlansin:

```
PENDING_PAYMENT
CONFIRMED
CHECKED_IN
CHECKED_OUT
CANCELLED
NO_SHOW
```

Beds24 statuslari PMS statuslariga mapping qilinsin.

---

## 9. DUPLICATE BRONLAR

Har bir external booking uchun:

```
channel
external_reservation_id
```

saqlansin.

Unique constraint bo'lsin.

Bir bron webhook/API orqali ikki marta kelib qolsa,
duplicate reservation yaratilmasin.

---

## 10. WEBHOOK

Beds24 webhook endpoint:

```
POST /api/webhooks/beds24
```

Webhook:

- validate
- eventni saqlash
- duplicate tekshirish
- queuega yuborish
- database update
- Shaxmatkani update qilish

Webhook ishlamasa polling/sync fallback mexanizmi bo'lsin.

---

## 11. SYNC QUEUE

Redis + BullMQ ishlatilsin.

Queue:

```
beds24-reservation-sync
beds24-availability-sync
beds24-rate-sync
beds24-webhook
beds24-retry
```

API xato bersa:

```
retry → retry → retry
```

bo'lsin.

Errorlar SyncLog'ga yozilsin.

---

## 12. CHANNEL MAPPING

Arxitektura faqat Beds24 bilan cheklanmasin.

Keyinchalik:

```
Booking.com
Airbnb
Expedia
Bronevik
MyBooking
```

kabi kanallarni qo'shish mumkin bo'ladigan qilib yozilsin.

Lekin API mavjud bo'lmagan platforma uchun
fake API, scraping yoki browser automation ishlatilmasin.

---

## 13. DATABASE

Kamida:

```
Channel
ChannelConnection
ChannelMapping
WebhookEvent
SyncLog
Reservation
Room
RoomType
Guest
Payment
RatePlan
Availability
```

jadvallari bo'lsin.

Beds24 API credentials frontendga chiqmasin.

---

## 14. TO'LOV

Beds24dan kelgan payment ma'lumotlari PMS reservation bilan bog'lansin.

PMSdagi:

```
totalPrice
paidAmount
remainingAmount
```

aniq hisoblanishi kerak.

Shaxmatkada:

```
To'liq to'langan
Qarz bor
```

holati ko'rinsin.

---

## 15. REAL-TIME SHAXMATKA

Beds24dan yangi bron kelganda:

```
Backend
 ↓
Database
 ↓
WebSocket
 ↓
Shaxmatka
```

Shaxmatka avtomatik yangilansin.

Events:

```
reservation.created
reservation.updated
reservation.cancelled
room.status.changed
availability.changed
payment.updated
```

---

## 16. SYNC LOG

Har bir sync:

- channel
- action
- request
- response
- status
- error
- timestamp
- reservation ID

bilan log qilinsin.

Secret/token/password log qilinmasin.

---

## 17. ERROR HOLATI

Beds24 vaqtincha ishlamasa:

PMS ishlashda davom etishi kerak.

Bron database'ga saqlansin.

Queue syncni kutib tursin.

Beds24 qayta ishlaganda avtomatik yuborilsin.

---

## 18. SECURITY

- API credentials faqat backendda
- .env / secure storage
- JWT authentication
- RBAC
- webhook validation
- rate limiting
- HTTPS
- audit log
- sensitive data log qilinmasin

---

## 19. ASOSIY QOIDA

PMSning ichki ishlashi Beds24ga bog'lanib qolmasin.

PMS + Database mustaqil ishlaydi.

Beds24 esa Channel Manager sifatida ikki tomonlama integratsiya qilinadi.

---

## 20. YAKUNIY NATIJA

Mijoz Website'dan bron qilsa:
→ Shaxmatkada ko'rinsin
→ xona band bo'lsin
→ Beds24ga yuborilsin
→ OTA availability yangilansin.

Booking.com/Airbnb/Expedia'dan bron kelsa:
→ Beds24 qabul qiladi
→ PMSga yuboradi
→ Database'ga yoziladi
→ Shaxmatkada avtomatik ko'rinadi
→ xona band bo'ladi.

Admin Shaxmatkada o'zgartirish qilsa:
→ Database yangilanadi
→ Beds24 yangilanadi
→ OTA kanallari yangilanadi.

**YA'NI BARCHA TIZIMLAR BIR XIL INVENTORY ASOSIDA ISHLASHI KERAK.**

---

# MIJOZ TOMONIDAN TASDIQLANGAN QARORLAR

TZ'dagi ochiq nuqtalar bo'yicha mijozdan olingan aniq javoblar.
Bular TZ bilan bir xil kuchga ega va texnik hujjatlarda shu tarzda
amalga oshirilgan.

| № | Savol | Mijoz javobi |
|---|---|---|
| Q1 | Xonalar Shaxmatkada qanday ko'rinadi | **Har xona alohida qator** bo'lib ko'rinadi. Beds24 o'z tomonida o'z tizimi bilan yuritadi — biz unga ma'lumot yuboramiz. |
| Q2 | Xona identifikatori | **Har xonaning o'z ID raqami bor** (`"101"`, `"202"`). `Room.id` = xona raqami. |
| Q3 | Beds24'dan kelgan bron qaysi xonaga tushadi | **Avtomatik** — PMS o'zi bo'sh xonani tanlaydi, admin aralashuvi kerak emas. Beds24 bronni allaqachon qabul qilgan, u Shaxmatkada darhol ko'rinishi shart. |
| Q5 | `PENDING_PAYMENT` va `NO_SHOW` statuslari | **Shaxmatkaga qo'shiladi** (Variant B). TZ 8-bandi 6 ta statusni talab qiladi — hammasi to'liq qo'llab-quvvatlanadi. |
| Q6 | Xona almashtirilsa | **Beds24'da ham ko'rinishi kerak** — sync majburiy. |
| Q7 | Check-in / check-out Beds24'ga | **Qo'llab-quvvatlanadi, muammo yo'q** — sync qilinadi. |
| Q8 | Dinamik (avtomatik o'suvchi) narxlash | **Mexanizm olib tashlanadi** (`base + confirmedCount × increment`) — TZ'da bunday talab yo'q va formula xato (jami bronlar soniga qaraydi, sanadagi bandlikka emas). **Narxlar paneli UI sifatida qoladi**, endi `RatePlan` qiymatlarini ko'rsatadi va tahrirlashga imkon beradi. |

**Qolgan barcha savollarga javob TZ'ning o'zidan olinadi** — mijoz
ko'rsatmasi: *"qolgan savolarga javobni shu TZ dan topasan"*. Ya'ni
TZ'da yozilgan narsa aynan yozilganidek bajariladi, TZ'da yo'q narsa
qo'shilmaydi va TZ talabi kuchsizlantirilmaydi.
