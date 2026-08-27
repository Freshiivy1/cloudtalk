# CloudTalk — all-in-one image (Vite frontend build + Hono/tRPC server bundle)
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# vite build → dist/public ; esbuild api/boot.ts → dist/boot.js
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# Server listens on PORT (platform-injected; default 3000)
EXPOSE 3000
CMD ["node", "dist/boot.js"]
