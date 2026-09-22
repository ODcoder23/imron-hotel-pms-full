# Server (Contabo VPS)

Butun infratuzilma serverda: `<SERVER_IP>`. Kompyuterda faqat kod.

> Haqiqiy IP va domen repoda saqlanmaydi. Skriptlar uchun `tools/.server`
> fayliga `root@<SERVER_IP>` yozing (git'ga kirmaydi).

Loyiha logikasi: [PROJECT_LOGIC.md](PROJECT_LOGIC.md) ·
Qolgan ishlar: [TODO.md](TODO.md)

---

## Production Manzillari (<DOMAIN>)

Loyiha to'liq `<DOMAIN>` domeniga ulangan (SSL / HTTPS + WSS):

| Manzil | Nima | Tavsif |
|---|---|---|
| `https://<DOMAIN>/` | Sayt | Mehmonlar uchun xonalar va bron qilish |
| `https://<DOMAIN>/shaxmatka` | Bandlik jadvali | Shaxmatka interfeysi |
| `https://<DOMAIN>/admin-panel` | Xodimlar paneli | PMS boshqaruv paneli |
| `https://<DOMAIN>/admin/mapping.html` | Xona mapping | Beds24 xona va tarif moslashuvi |
| `https://<DOMAIN>/admin/connection.html` | Ulanish holati | Beds24 ulanishi va hisob balansi |
| `https://<DOMAIN>/admin/sync-log.html` | Sinxronizatsiya jurnali | Hodisalar va xatoliklar tarixi |
| `wss://<DOMAIN>/ws` | Real-time WebSocket | Shaxmatka va admin panel jonli yangilanishi |
| `https://<DOMAIN>/health` | Health Check | Tizim holati (DB, Redis, Realtime, Security) |

Kirish: `founder@imron.local` / `admin12345` (to'liq huquq).
Boshqa rollar: `admin@`, `manager@`, `staff@` — bir xil parol.

---

## Lokal Dasturchi Rejimi (SSH Tunnel)

Lokal ishlab chiqishda:
```bash
bash tools/tunnel.sh        # terminal ochiq qoladi
```

Tunnel ochilgach brauzerda:
`http://localhost:3100`, `http://localhost:3100/shaxmatka`, `http://localhost:3100/admin-panel`

---

## Kod yuborish

```bash
bash tools/sync.sh            # yuborish
bash tools/sync.sh restart    # yuborish + qayta ishga tushirish
```

Yuboriladi: `backend/src`, `prisma`, `public`, `tools`,
`package.json`, `mock-beds24`.
Yuborilmaydi: `node_modules`, `.env`, `dist` — serverning o'z
nusxasi bor.

**Server `dist/` ni ishlatadi.** Kod o'zgarsa serverda build
qilish shart:

```bash
ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'cd /opt/hotel-pms/backend && npx tsc && systemctl restart hotel-backend'
```

---

## Nima qayerda

```
KOMPYUTER                          SERVER (<SERVER_IP>)
─────────                          ────────────────────
zakas042/backend/    ──sync.sh──>  /opt/hotel-pms/backend/
  src/ prisma/ public/               src/ prisma/ public/ dist/
                                     .env  (server portlari)

                                   Docker:
                                     hotel-postgres  :5433
                                     hotel-redis     :6380
                                   systemd:
                                     hotel-backend   :3100
                                     hotel-mock      :4100
```

---

## Portlar

Serverda boshqa loyihalar ham bor, to'qnashmaslik uchun:

| Port | Nima | Nega bu raqam |
|---|---|---|
| 3100 | backend | 3000 da boshqa loyiha |
| 4100 | mock Beds24 | bir xil uslub |
| 5433 | PostgreSQL | 5432 band |
| 6380 | Redis | 6379 band bo'lishi mumkin |

**Hammasi `127.0.0.1` ga bog'langan** — internetdan kirib
bo'lmaydi. SSH tunnel yagona yo'l.

---

## Izolyatsiya

Serverdagi boshqa loyihalar tegilmagan:

| Chora | Qanday |
|---|---|
| Alohida tarmoq | `hotel_net` |
| Alohida nom | `hotel-` prefiksi |
| Alohida volume | `hotel_pgdata`, `hotel_redisdata` |
| RAM chegarasi | postgres 1GB, redis 256MB |
| Alohida papka | `/opt/hotel-pms` |

`restart.sh` faqat `hotel-pms` yo'lidagi jarayonlarni to'xtatadi.

---

## Xizmatlar

```bash
systemctl status hotel-backend
systemctl status hotel-mock
systemctl restart hotel-backend
journalctl -u hotel-backend -n 50 --no-pager
```

Ikkalasi ham `Restart=always` — qulasa o'zi ko'tariladi.

---

## Zaxira

Kunlik, soat 03:00 da (cron):

```
0 3 * * * /opt/hotel-pms/backup.sh
```

Zaxiralar `/opt/hotel-pms/backups/` da. Tiklash tekshirilgan.

---

## Muammo bo'lsa

```bash
bash tools/status.sh          # umumiy holat

ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'journalctl -u hotel-backend -n 40 --no-pager'

ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'systemctl restart hotel-backend'

ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'cd /opt/hotel-pms && docker compose restart'
```

**Bazaga to'g'ridan-to'g'ri ulanish** (tunnel ochiq bo'lsa):

```
postgresql://imron:imron@localhost:5433/imron_pms
```

---

## Xavfsizlik eslatmasi

Server SSH paroli va seed parollari hali o'zgartirilmagan —
[TODO.md](TODO.md) dagi "Production'dan oldin" bo'limiga qarang.
