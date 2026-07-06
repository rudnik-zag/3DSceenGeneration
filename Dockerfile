FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm db:generate
RUN pnpm build

RUN mkdir -p /app/.local-storage /app/.run && chown -R node:node /app/.local-storage /app/.run /app/.next

EXPOSE 3000
USER node
ENV NODE_ENV=production
CMD ["pnpm", "start"]
