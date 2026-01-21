# syntax=docker/dockerfile:1

# 使用 Debian slim 镜像而非 Alpine，避免 Sharp 库在 musl libc 上的兼容性问题
# Debian 使用 glibc，Sharp 预编译二进制可以直接使用，无需重新编译
ARG NODE_VERSION=20-bookworm-slim

FROM node:${NODE_VERSION} AS builder

WORKDIR /app

ENV NODE_ENV=production
ENV DOCKER_CONTAINER=true

# 安装构建依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 复制 package.json 和 start.js
COPY package.json package-lock.json* start.js ./

# 复制源代码
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend

# 安装所有依赖（包括开发依赖）
RUN npm install --include=dev && \
    npm install --workspaces --include=dev

# 设置环境文件（会自动生成 JWT_SECRET）
RUN node start.js --env-only

# 构建前端和后端
RUN cd backend && npm run build && \
    cd ../frontend && npm run build

# 清理开发依赖，仅保留生产依赖
RUN npm install --workspaces --omit=dev

# 生产镜像
FROM node:${NODE_VERSION}

WORKDIR /app

ENV NODE_ENV=production
ENV DOCKER_CONTAINER=true

# 只安装运行时依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 从 builder 阶段复制构建产物
COPY --from=builder /app/package.json /app/package-lock.json* /app/start.js ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/package.json ./backend/package.json
COPY --from=builder /app/frontend/package.json ./frontend/package.json
COPY --from=builder /app/backend/node_modules ./backend/node_modules
COPY --from=builder /app/frontend/node_modules ./frontend/node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/backend/.env ./backend/.env

# 复制后端源代码（用于运行时访问）
COPY --from=builder /app/backend/src ./backend/src

# 创建数据目录
RUN mkdir -p /app/backend/data

# 复制环境文件（如果需要）
# 注意：生产环境应该通过环境变量注入，而不是直接复制 .env 文件

EXPOSE 3000 3001

# 设置默认环境变量（可以被 docker run 覆盖）
ENV PORT=3000
ENV WS_PORT=3001
ENV DB_FILE=data/mindmap.db
ENV LOG_FILE=data/app.log
ENV ALLOWED_ORIGINS=*

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# 使用 start.js 启动，它会自动初始化数据库并启动服务
CMD ["node", "start.js", "--start-only"]
