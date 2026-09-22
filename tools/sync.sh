#!/bin/bash
# ============================================================
#  Kodni serverga yuborish
#
#  Ishlatish:
#    bash tools/sync.sh          — yuboradi
#    bash tools/sync.sh restart  — yuboradi va qayta ishga tushiradi
#
#  `node_modules` va `.env` yuborilmaydi: serverning o'z nusxasi
#  bor (portlar boshqacha). `package.json` esa yuboriladi —
#  yangi kutubxona qo'shilsa serverda ham o'rnatilishi kerak.
# ============================================================
set -e

source "$(dirname "${BASH_SOURCE[0]}")/_server.sh"
KEY="$HOME/.ssh/hotel_vps"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="$(cd "$SCRIPT_DIR/../zakas042" && pwd)"
REMOTE="/opt/hotel-pms"

echo "Kod yuborilmoqda: $LOCAL -> $SERVER:$REMOTE"
cd "$LOCAL"
# `mock-beds24` va `backend/tools` 2026-09-17 da qo'shildi.
#
# Ilgari mock yuborilmasdi va serverdagi nusxa eskirib qolgan edi:
# PMS 18 xonaga o'tganda mock 12 xonaligicha turaverdi, natijada
# 9 tarifdan 6 tasini Beds24'ga bog'lab bo'lmasdi.
#
# `backend/tools` — Tailwind CSS'ni qayta yasash uchun
# (`npm run build:css`, public/app/vendor/README.md).
tar --exclude=node_modules --exclude=.git --exclude=dist --exclude=.env \
    -czf /tmp/sync.tgz \
    backend/src backend/prisma backend/public backend/tools backend/scripts \
    backend/package.json backend/package-lock.json \
    backend/tsconfig.json backend/tsconfig.test.json \
    mock-beds24 2>/dev/null

scp -q -i "$KEY" /tmp/sync.tgz "$SERVER:/tmp/"
ssh -i "$KEY" "$SERVER" "cd $REMOTE && tar xzf /tmp/sync.tgz && rm /tmp/sync.tgz && echo '  yuborildi'"
rm -f /tmp/sync.tgz

# Yangi bog'liqlik bormi. `npm install` mavjudlarini qayta
# yuklamaydi — o'zgarish bo'lmasa bir necha soniyada tugaydi.
echo "Bog'liqliklar..."
ssh -i "$KEY" "$SERVER" "cd $REMOTE/backend && npm install --no-audit --no-fund 2>&1 | tail -2"

if [ "$1" = "restart" ]; then
  echo "Qayta ishga tushirilmoqda..."
  ssh -i "$KEY" "$SERVER" "bash $REMOTE/restart.sh"
fi
