FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json ./
RUN pnpm install --no-frozen-lockfile

COPY . .
RUN pnpm db:generate

EXPOSE 3000
CMD ["pnpm", "dev"]
