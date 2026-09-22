/**
 * Shaxmatka uchun Tailwind konfiguratsiyasi (2026-09-17).
 *
 * NEGA KERAK: `shaxmatka.html` ilgari `cdn.tailwindcss.com` dan
 * yuklanardi — u brauzerda class'larni skanerlab CSS yasaydi
 * (JIT). Internet uzilsa sahifa stilsiz qolardi.
 *
 * Endi CSS oldindan yasaladi. `content` faqat bitta faylni
 * ko'rsatadi: sayt va admin panel Tailwind ishlatmaydi, ularda
 * o'z CSS'i bor.
 *
 * Qayta yasash (backend/ papkasidan):
 *   npx tailwindcss -c tools/tailwind.config.cjs \
 *     -i tools/tailwind.css -o public/app/vendor/tailwind.css --minify
 *
 * DIQQAT: yangi Tailwind class qo'shsangiz shu buyruqni qayta
 * ishga tushiring, aks holda class CSS'ga tushmaydi va uslub
 * qo'llanmaydi. Dinamik class'lar to'liq matn bo'lishi shart
 * (`bg-blue-600` ha, `bg-${color}-600` yo'q) — skaner faqat
 * to'liq satrlarni ko'radi.
 */
module.exports = {
  content: ["./public/app/shaxmatka.html"],
  theme: { extend: {} },
  plugins: [],
};
