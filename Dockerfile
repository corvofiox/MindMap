# syntax=docker/dockerfile:1

# 使用Debian slim镜像而非Alpine，避免Sharp库在musl libc上的兼容性问题
# Debian使用glibc，Sharp预编译二进制可以直接使用，无需重新编译
ARG NODE_VERSION=20-bookworm-slim

FROM node:${NODE_VERSION}

WORKDIR /app

ENV NODE_ENV=production
ENV DOCKER_CONTAINER=true

# 安装构建依赖（Debian使用apt-get）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* start.js ./

COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend

# 安装依赖（Debian环境下Sharp可直接使用预编译二进制）
RUN npm install --include=dev && \
    npm install --workspaces --include=dev

RUN node start.js --env-only

RUN cd backend && npm run build && \
    cd ../frontend && npm run build

# 清理开发依赖，保留生产依赖
RUN npm prune --omit=dev && \
    npm install --workspaces --omit=dev

RUN mkdir -p /app/backend/data

EXPOSE 3000 3001

WORKDIR /app/backend

ENV PORT=3000
ENV WS_PORT=3001
ENV DB_FILE=data/mindmap.db
ENV LOG_FILE=data/app.log
ENV ALLOWED_ORIGINS=*

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "../start.js", "--start-only"]
