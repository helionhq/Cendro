# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_APP_BUILD=local

ENV NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_APP_BUILD=$NEXT_PUBLIC_APP_BUILD \
    NEXT_PUBLIC_CONVEX_RELAY=true \
    NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in \
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up \
    NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard \
    NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/dashboard \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app

# deploy/update.sh refuses an image whose baked Convex URL differs from the
# Caddy relay's upstream in deploy/.env.
ARG NEXT_PUBLIC_CONVEX_URL
LABEL im.cendro.convex-url=$NEXT_PUBLIC_CONVEX_URL

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=builder /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
CMD ["node", "server.js"]
