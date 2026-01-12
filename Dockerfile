# --- 构建阶段 ---
FROM node:20-slim AS builder

# 设置sharp使用预编译二进制文件的环境变量
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
ENV SHARP_USE_SYSTEM_LIBVIPS=1

# 安装构建依赖 (编译 native 模块所需)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libvips-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY shared/package*.json ./shared/
COPY frontend/package*.json ./frontend/
COPY backend/package*.json ./backend/

# 全局安装node-gyp
RUN npm install -g node-gyp

# 使用npm install代替npm ci，自动处理依赖并更新lock文件
RUN npm install --workspaces

COPY . .

RUN npm run build:frontend
RUN npm run build:backend

FROM node:20-slim

# 安装运行时依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared/node_modules ./shared/node_modules
COPY --from=builder /app/frontend/node_modules ./frontend/node_modules
COPY --from=builder /app/backend/node_modules ./backend/node_modules

COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/generate-env.js /app/start-all.js ./

RUN mkdir -p /app/backend/data

EXPOSE 3000 3001

CMD ["node", "start-all.js", "--docker", "--mode=production"]