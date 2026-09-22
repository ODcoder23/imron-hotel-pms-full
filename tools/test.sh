#!/bin/bash
# ============================================================
#  Testlarni serverda ishga tushirish
#
#  Ishlatish:  bash tools/test.sh
#              bash tools/test.sh src/api.test.ts   (bitta fayl)
# ============================================================
source "$(dirname "${BASH_SOURCE[0]}")/_server.sh"
KEY="$HOME/.ssh/hotel_vps"
ssh -i "$KEY" "$SERVER" "cd /opt/hotel-pms/backend && PMS_URL=http://localhost:3100 MOCK_URL=http://localhost:4100 npx vitest run $1 2>&1 | tail -25"
