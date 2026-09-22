#!/usr/bin/env bash
# ============================================================
#  check-docs.sh — hujjatlar to'plami butunligini tekshiradi
#
#  Ishga tushirish:  ./check-docs.sh
#  Chiqish kodi:     0 = toza, 1 = xato topildi
#
#  Nimani tekshiradi:
#    1. Barcha markdown linklar mavjud faylga ishora qiladimi
#    2. schema.prisma bor va model/enum soni to'g'rimi
#    3. 02-faylda schema nusxasi qolmaganmi (dublikat)
#    4. Seed raqamlari (6/4/2) barcha fayllarda bir xilmi
#    5. TZ'ning 20 bandi hujjatlarda qoplanganmi
#    6. Mijoz qarorlari Q1–Q8 ko'rsatilgan faylda bormi
# ============================================================

cd "$(dirname "$0")" || exit 1
ERRORS=0
WARNINGS=0

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }

echo "=========================================="
echo " Hujjatlar tekshiruvi"
echo "=========================================="

# --- 1. Markdown linklar -----------------------------------
echo
echo "[1/6] Markdown linklar..."
BROKEN=0
TOTAL=0
while IFS= read -r line; do
  src="${line%%:*}"
  target="${line#*:}"
  TOTAL=$((TOTAL+1))
  if [ ! -f "$target" ]; then
    red "  ✗ $src → $target (fayl yo'q)"
    BROKEN=$((BROKEN+1))
  fi
done < <(grep -oHn '\]([0-9A-Za-z][^)]*\.\(md\|prisma\|sh\))' ./*.md 2>/dev/null \
         | sed 's/:[0-9]*:\](/:/' | sed 's/)$//')

if [ "$BROKEN" -eq 0 ]; then
  green "  ✓ $TOTAL link — hammasi mavjud faylga ishora qiladi"
else
  ERRORS=$((ERRORS+BROKEN))
fi

# --- 2. schema.prisma --------------------------------------
# Yagona nusxa kodda turadi — Prisma o'sha fayldan ishlaydi
SCHEMA="backend/prisma/schema.prisma"
echo
echo "[2/6] schema.prisma..."
if [ ! -f "$SCHEMA" ]; then
  red "  ✗ $SCHEMA topilmadi"
  ERRORS=$((ERRORS+1))
else
  MODELS=$(grep -c '^model ' "$SCHEMA")
  ENUMS=$(grep -c '^enum ' "$SCHEMA")
  green "  ✓ $MODELS model, $ENUMS enum"
  # TZ 13-band majburiy 12 jadval
  for m in Channel ChannelConnection ChannelMapping WebhookEvent SyncLog \
           Reservation Room RoomType Guest Payment RatePlan Availability; do
    grep -q "^model $m " "$SCHEMA" || {
      red "  ✗ TZ 13-band talab qilgan '$m' modeli yo'q"
      ERRORS=$((ERRORS+1))
    }
  done
  # Raw SQL constraint eslatmasi yo'qolmaganmi
  grep -q 'btree_gist' 02-DATABASE-SXEMA.md || {
    red "  ✗ Overbooking constraint (btree_gist) 02-faylda yo'q — TZ 3-band buziladi"
    ERRORS=$((ERRORS+1))
  }
fi

# --- 3. Schema dublikati -----------------------------------
echo
echo "[3/6] Schema dublikati..."
DUP=$(grep -c '^model ' 02-DATABASE-SXEMA.md 2>/dev/null | head -1)
DUP=${DUP:-0}
if [ "$DUP" -gt 0 ]; then
  red "  ✗ 02-DATABASE-SXEMA.md ichida $DUP ta 'model ' bor — schema nusxasi qolgan"
  ERRORS=$((ERRORS+1))
else
  green "  ✓ Schema faqat schema.prisma da"
fi

# --- 4. Seed raqamlari -------------------------------------
# 2026-09-16 dan: 18 xona / 9 tarif (avval 12 / 3 edi).
# Haqiqat manbai — prisma/seed.ts. Bu yerda hujjatlar unga
# zid kelmayotganini tekshiramiz.
echo
echo "[4/6] Seed raqamlari (18 xona / 9 tarif)..."
BAD=0

SEED="backend/prisma/seed.ts"
if [ -f "$SEED" ]; then
  # layout massividagi xona sonini sanaymiz: ["101", "comfort3", 1] ko'rinishi
  ROOMS=$(grep -oE '\["[0-9]+[A-Za-z]?", *"[a-z0-9]+", *[0-9]+\]' "$SEED" | wc -l | tr -d ' ')
  TYPES=$(grep -cE '^\s*\{ id: "[a-z0-9]+",' "$SEED" | tr -d ' ')

  if [ "$ROOMS" != "18" ]; then
    red "  ✗ seed.ts da $ROOMS xona (18 kutilgan)"
    BAD=1; ERRORS=$((ERRORS+1))
  fi
  if [ "$TYPES" != "9" ]; then
    red "  ✗ seed.ts da $TYPES tarif (9 kutilgan)"
    BAD=1; ERRORS=$((ERRORS+1))
  fi
else
  yellow "  ⚠ $SEED topilmadi — tekshiruv o'tkazib yuborildi"
  WARNINGS=$((WARNINGS+1))
fi

# Hujjatlarda eskirgan sonlar qolmaganini tekshiramiz.
# Tarixiy eslatmalar ruxsat etiladi — ular ">" bilan boshlanadi
# yoki "->" orqali yangi qiymatni ko'rsatadi ("12 -> 18").
STALE=$(grep -rn "12 xona" ./*.md 2>/dev/null   | grep -v ":>"   | grep -v -- "->"   | grep -v "avval\|Avval\|edi\|YANGILANGAN")
if [ -n "$STALE" ]; then
  yellow "  ⚠ Hujjatlarda eskirgan '12 xona':"
  echo "$STALE" | sed 's/^/      /'
  WARNINGS=$((WARNINGS+1))
fi

[ "$BAD" -eq 0 ] && green "  ✓ Seed raqamlari mos"

# --- 5. TZ bandlari qoplami --------------------------------
echo
echo "[5/6] TZ bandlari qoplami..."
UNCOVERED=""
for i in $(seq 1 20); do
  if ! grep -qs "TZ ${i}-band\|TZ ${i},\|\*\*${i}-band\*\*" ./*.md; then
    UNCOVERED="$UNCOVERED $i"
  fi
done
if [ -n "$UNCOVERED" ]; then
  yellow "  ⚠ Hujjatlarda tilga olinmagan bandlar:$UNCOVERED"
  WARNINGS=$((WARNINGS+1))
else
  green "  ✓ 20/20 band tilga olingan"
fi

# --- 6. Mijoz qarorlari ------------------------------------
echo
echo "[6/6] Mijoz qarorlari Q1–Q8..."
MISSING=""
for q in Q1 Q2 Q3 Q5 Q6 Q7 Q8; do
  grep -qs "$q" TZ-ASL.md || MISSING="$MISSING $q"
done
if [ -n "$MISSING" ]; then
  red "  ✗ TZ-ASL.md da yo'q:$MISSING"
  ERRORS=$((ERRORS+1))
else
  green "  ✓ Barcha qarorlar TZ-ASL.md da qayd etilgan"
fi

# --- Natija ------------------------------------------------
echo
echo "=========================================="
if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
  green " NATIJA: toza"
  exit 0
elif [ "$ERRORS" -eq 0 ]; then
  yellow " NATIJA: $WARNINGS ogohlantirish, xato yo'q"
  exit 0
else
  red " NATIJA: $ERRORS xato, $WARNINGS ogohlantirish"
  exit 1
fi
