# vendor — mahalliy kutubxonalar

`shaxmatka.html` shu papkadagi fayllardan foydalanadi.

## Nega bu yerda

Ilgari to'rt fayl CDN'dan yuklanardi:

```
https://cdn.tailwindcss.com
https://unpkg.com/react@18/umd/react.production.min.js
https://unpkg.com/react-dom@18/umd/react-dom.production.min.js
https://unpkg.com/@babel/standalone@7/babel.min.js
```

Internet uzilsa yoki CDN ishlamasa **Shaxmatka umuman
ochilmasdi** — qabulxona xodimi bandlik jadvalini ko'ra
olmasdi. Sayt (`index.html`) va admin panel
(`admin-panel.html`) allaqachon mustaqil edi, faqat shu
sahifa qolgan.

2026-09-17 auditida mahalliy nusxaga o'tkazildi.

## Fayllar

| Fayl | Versiya | Hajm | Manba |
|---|---|---|---|
| `react.production.min.js` | 18.3.1 | 11 KB | unpkg |
| `react-dom.production.min.js` | 18.3.1 | 129 KB | unpkg |
| `babel.min.js` | 7.26.4 | 2.9 MB | unpkg |
| `tailwind.css` | 3.4.17 dan yasalgan | 20 KB | mahalliy build |

## Tailwind — muhim farq

CDN versiyasi (`cdn.tailwindcss.com`) brauzerda class'larni
skanerlab CSS yasaydi (JIT). Mahalliy nusxada bu ishlamaydi,
shuning uchun CSS **oldindan yasalgan**: faqat
`shaxmatka.html` da ishlatilgan class'lar kiradi.

**Yangi Tailwind class qo'shsangiz CSS ni qayta yasang**,
aks holda uslub qo'llanmaydi:

```
cd backend
npm run build:css
```

Dinamik class'lar to'liq matn bo'lishi shart — skaner faqat
to'liq satrlarni ko'radi:

```jsx
className={`... ${ok ? "bg-green-500" : "bg-red-500"}`}   // ✅ topiladi
className={`bg-${color}-500`}                             // ❌ topilmaydi
```

## Babel haqida

Babel (2.9 MB) JSX'ni brauzerda kompilyatsiya qiladi — har
ochishda ~95 KB JSX qayta ishlanadi. Buni ham olib tashlash
mumkin: JSX'ni oldindan JS'ga o'girish kerak, lekin u holda
`shaxmatka.html` ni tahrirlagan har safar build qilish
kerak bo'ladi. Hozircha tahrirlash qulayligi saqlangan.

## Yangilash

Versiyani ko'tarish kerak bo'lsa:

```
cd backend/public/app/vendor
curl -sL -o react.production.min.js \
  https://unpkg.com/react@18.3.1/umd/react.production.min.js
curl -sL -o react-dom.production.min.js \
  https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js
curl -sL -o babel.min.js \
  https://unpkg.com/@babel/standalone@7.26.4/babel.min.js
```

React va ReactDOM versiyalari **bir xil** bo'lishi shart.
