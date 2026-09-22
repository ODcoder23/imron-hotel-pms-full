# Imron Hotel PMS

Mehmonxona boshqaruv tizimi: sayt, bandlik jadvali (Shaxmatka),
xodimlar paneli va Beds24 channel manager integratsiyasi.

```
Booking.com / Airbnb / Expedia
            |
         Beds24
            |  API v2 + Webhook
      PMS Backend  <->  PostgreSQL
            |  WebSocket
   Shaxmatka / Admin panel / Sayt
```

---

## Qayerdan boshlash

| Hujjat | Nima uchun |
|---|---|
| **[PROJECT_LOGIC.md](PROJECT_LOGIC.md)** | Loyiha qanday ishlaydi — qoidalar, modellar, oqimlar, ruxsatlar. **Avval shuni o'qing.** |
| **[TODO.md](TODO.md)** | Qolgan ishlar va aniqlangan muammolar |
| [SERVER.md](SERVER.md) | Serverda ishlash tartibi |
| [zakas042/TZ-ASL.md](zakas042/TZ-ASL.md) | Mijozning asl topshirig'i (arxiv) |

---

## Tez boshlash

Butun infratuzilma **serverda** (Contabo VPS). Kompyuterda faqat kod.

```bash
bash tools/tunnel.sh        # tunnel ochish, terminal ochiq qoladi
```

Keyin brauzerda:

| Manzil | Nima |
|---|---|
| `http://localhost:3100` | Sayt (mehmonlar) |
| `http://localhost:3100/shaxmatka` | Bandlik jadvali |
| `http://localhost:3100/admin-panel` | Xodimlar paneli |

Kirish: `founder@imron.local` / `admin12345`

Kod o'zgartirgach:

```bash
bash tools/sync.sh restart  # serverga yuborish + qayta ishga tushirish
bash tools/status.sh        # holat
```

---

## Tuzilma

```
HotellAllcode/
├── PROJECT_LOGIC.md          loyiha logikasi — asosiy referens
├── TODO.md                   qolgan ishlar
├── SERVER.md                 server bilan ishlash
│
├── zakas042/                 asosiy loyiha
│   ├── backend/
│   │   ├── src/
│   │   │   ├── routes/       HTTP, validatsiya, auth
│   │   │   ├── services/     biznes mantiq
│   │   │   ├── queues/       BullMQ worker'lar
│   │   │   ├── realtime/     WebSocket
│   │   │   ├── bot/          Telegram (2 bot)
│   │   │   └── lib/          config, xatolar, auth middleware
│   │   ├── prisma/           sxema, 17 migratsiya, seed
│   │   └── public/
│   │       ├── app/          frontend (3 sahifa + vendor/)
│   │       └── admin/        mapping, connection, sync-log
│   ├── mock-beds24/          Beds24 taqlidi
│   └── TZ-ASL.md             mijoz talabi (arxiv)
│
└── tools/                    tunnel, sync, test, status
```

---

## Asosiy raqamlar

| Narsa | Qiymat |
|---|---|
| Xona | 18 (3 qavat) |
| Tarif | 9 |
| Valyuta | UZS |
| Prisma modellari | 23 |
| Migratsiyalar | 17 |
| API endpoint | 85 |
| Testlar | 153 o'tadi (backend 4/13 fayl + mock sinalgan) |

---

## Hozirgi holat

**Ishlaydi:** sayt → bron → Shaxmatka → Beds24 zanjiri,
overbooking himoyasi (3 qatlam), tozalik boti (Telegram guruh),
oshxona hisobi, 4 rolli RBAC, kunlik zaxira.

**Sinov rejimida:** autentifikatsiya va so'rov cheklovi
o'chirilgan (`AUTH_REQUIRED=false`). Mehmonlar foydalanishidan
oldin yoqilishi shart — [TODO.md](TODO.md).

**Beds24:** mock server bilan ishlaydi, real hisob ulanmagan.
