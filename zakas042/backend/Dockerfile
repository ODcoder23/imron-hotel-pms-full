# Imron Hotel PMS — backend
#
# Manba: 01-ARXITEKTURA-VA-QOIDALAR.md §5, 11-BOSQICHLAR-ROADMAP.md FAZA 0
#
# IKKI BOSQICHLI QURILISH: build bosqichida devDependencies va
# TypeScript kerak, ishga tushirishda esa faqat kompilyatsiya
# natijasi. Natijada tasvir kichik bo'ladi va ishlab chiqarishda
# ortiqcha paketlar turmaydi (TZ 18-band: hujum yuzasini kamaytirish).

# ---------- 1. Build ----------
FROM node:22-alpine AS build

WORKDIR /app

# Avval faqat manifest — kod o'zgarganda npm ci qayta ishlamasligi
# uchun (Docker layer cache)
COPY package*.json ./
RUN npm ci

# Prisma client kodni kompilyatsiya qilishdan OLDIN yasaladi:
# TypeScript unga tayanadi
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---------- 2. Runtime ----------
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Faqat ishlab chiqarish paketlari
COPY package*.json ./
RUN npm ci --omit=dev

# Prisma client va migratsiyalar
COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist
COPY public ./public
COPY scripts ./scripts

# Root emas — konteyner buzilsa ham zarar chegaralangan
USER node

EXPOSE 3000

# `dumb-init` yo'q: Node 22 o'zi SIGTERM ni to'g'ri qabul qiladi va
# server.ts da toza to'xtash yozilgan (queue, Prisma, WebSocket)
CMD ["node", "dist/server.js"]
