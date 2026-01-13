# syntax=docker/dockerfile:1

ARG NODE_VERSION=20-alpine

# =============================================================================
# Base Stage
# =============================================================================
FROM node:${NODE_VERSION} AS base

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache python3 make g++ vips-dev

# =============================================================================
# Dependencies Stage - Install all npm dependencies
# =============================================================================
FROM base AS deps

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --ignore-scripts

COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend

RUN npm install --workspaces --ignore-scripts

# =============================================================================
# Backend Build Stage - Compile TypeScript
# =============================================================================
FROM base AS backend-builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY --from=deps /app/shared ./shared
COPY --from=deps /app/backend ./backend

WORKDIR /app/backend

RUN npm install --include=dev

RUN JWT_SECRET=$(head -c 64 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 64) && \
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" .env.example && \
    cp .env.example .env

RUN npm run build

# =============================================================================
# Frontend Build Stage - Build with Vite
# =============================================================================
FROM base AS frontend-builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY --from=deps /app/shared ./shared
COPY --from=deps /app/frontend ./frontend

WORKDIR /app/frontend

RUN npm install --include=dev

ENV VITE_API_URL=/api
ENV VITE_WS_URL=ws://localhost:3001

RUN npm run build

# =============================================================================
# Production Stage - Final image
# =============================================================================
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=backend-builder /app/backend/dist ./backend/dist
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY --from=backend-builder /app/backend/package.json ./backend/package.json
COPY --from=backend-builder /app/backend/.env ./backend/.env

COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY --from=deps /app/shared ./shared
COPY --from=deps /app/backend ./backend
COPY --from=deps /app/frontend ./frontend

RUN apk add --no-cache python3 make g++ && \
    npm rebuild bcrypt && \
    cd backend && npm rebuild bcrypt && \
    cd .. && apk del python3 make g++

RUN mkdir -p /app/backend/data /app/backend/logs

EXPOSE 3000 3001

WORKDIR /app/backend

ENV PORT=3000
ENV WS_PORT=3001
ENV DB_FILE=data/mindmap.db
ENV LOG_FILE=data/app.log
ENV ALLOWED_ORIGINS=*
ENV VITE_API_URL=/api
ENV VITE_WS_URL=ws://localhost:3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
