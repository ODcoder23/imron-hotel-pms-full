#!/bin/bash
# ============================================================
#  SSH tunnel — serverdagi Hotel PMS'ga ulanish
#
#  Ishga tushirish:  bash tools/tunnel.sh
#  To'xtatish:       Ctrl+C
#
#  Tunnel ochilgach brauzerda:
#    http://localhost:3100              sayt
#    http://localhost:3100/shaxmatka    bandlik jadvali
#    http://localhost:3100/admin-panel  boshqaruv paneli
#
#  Baza (DBeaver / psql uchun):
#    postgresql://imron:imron@localhost:5433/imron_pms
#
#  DIQQAT: server portlari 127.0.0.1 ga bog'langan — internetdan
#  kirib bo'lmaydi. Shu tunnel yagona yo'l.
# ============================================================

source "$(dirname "${BASH_SOURCE[0]}")/_server.sh"
KEY="$HOME/.ssh/hotel_vps"

echo "Tunnel ochilmoqda: $SERVER"
echo
echo "  3100 -> backend (sayt, shaxmatka, admin panel)"
echo "  4100 -> mock Beds24"
echo "  5433 -> PostgreSQL"
echo "  6380 -> Redis"
echo
echo "To'xtatish uchun Ctrl+C"
echo

ssh -N -i "$KEY" -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -L 3100:localhost:3100 -L 4100:localhost:4100 -L 5433:localhost:5433 -L 6380:localhost:6380 "$SERVER"
