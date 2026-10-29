# Build từ thư mục gốc repo: docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter api...
COPY apps/api apps/api
RUN pnpm --filter api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
RUN mkdir -p /app/apps/api/storage && chown -R node:node /app/apps/api/storage
USER node
EXPOSE 4000
# Lệnh mặc định chạy API; dịch vụ worker ghi đè bằng "node dist/worker.js"
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
