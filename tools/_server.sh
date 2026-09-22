# Server manzili git'ga kiritilmaydi: PMS_SERVER o'zgaruvchisidan
# yoki tools/.server faylidan (masalan: root@1.2.3.4) o'qiladi.
SERVER="${PMS_SERVER:-$(cat "$(dirname "${BASH_SOURCE[0]}")/.server" 2>/dev/null)}"
if [ -z "$SERVER" ]; then
  echo "Server manzili topilmadi: tools/.server fayliga 'root@IP' yozing yoki PMS_SERVER ni o'rnating." >&2
  exit 1
fi
