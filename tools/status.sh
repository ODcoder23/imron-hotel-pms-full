#!/bin/bash
# ============================================================
#  Server holatini tekshirish
# ============================================================
SERVER="root@212.47.71.36"
KEY="$HOME/.ssh/hotel_vps"

ssh -i "$KEY" "$SERVER" 'bash -s' << 'REMOTE'
echo "=== Xizmatlar (systemd) ==="
for s in hotel-backend hotel-mock; do
  state=$(systemctl is-active "$s" 2>/dev/null)
  since=$(systemctl show -p ActiveEnterTimestamp --value "$s" 2>/dev/null | cut -d' ' -f2 | cut -d'.' -f1)
  echo "  $s: $state (${since:-—} dan)"
done

echo
echo "=== Konteynerlar ==="
docker ps --filter "name=hotel-" --format '  {{.Names}}: {{.Status}}'

echo
echo "=== Javoblar ==="
curl -s -o /dev/null -m 5 -w "  backend (3100): %{http_code}\n" http://localhost:3100/health
curl -s -o /dev/null -m 5 -w "  mock    (4100): %{http_code}\n" http://localhost:4100/

echo
echo "=== Baza ==="
docker exec hotel-postgres psql -U imron -d imron_pms -t -c \
  "SELECT '  xona: ' || COUNT(*) FROM \"Room\"
   UNION ALL SELECT '  tarif: ' || COUNT(*) FROM \"RoomType\"
   UNION ALL SELECT '  bron: ' || COUNT(*) FROM \"Reservation\";" 2>/dev/null

echo "=== Zaxira ==="
COUNT=$(find /opt/hotel-pms/backups -name 'db-*.sql.gz' 2>/dev/null | wc -l)
LAST=$(ls -t /opt/hotel-pms/backups/db-*.sql.gz 2>/dev/null | head -1)
if [ -n "$LAST" ]; then
  echo "  $COUNT ta nusxa, oxirgisi: $(basename "$LAST") ($(stat -c%s "$LAST" | numfmt --to=iec))"
else
  echo "  ZAXIRA YO'Q"
fi

echo
echo "=== RAM ==="
free -h | awk 'NR==2{print "  bosh: " $7 " / " $2}'
REMOTE
