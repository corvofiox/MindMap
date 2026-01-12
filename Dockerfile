# 构建阶段
FROM node:20-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制必要文件
COPY package*.json ./
COPY shared/package*.json shared/
COPY shared/src shared/src
COPY frontend/package*.json frontend/
COPY backend/package*.json backend/
COPY backend/drizzle.config.ts backend/
COPY backend/.env.example backend/
COPY generate-env.js ./

# 安装所有依赖
RUN npm ci --workspaces

# 构建前端
COPY frontend/ ./frontend/
RUN npm run build:frontend

# 构建后端
COPY backend/ ./backend/
RUN npm run build:backend

# 运行阶段
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV WS_PORT=3001

# 复制构建产物
COPY --from=builder /app/frontend/dist /app/frontend/dist
COPY --from=builder /app/backend/dist /app/backend/dist
COPY --from=builder /app/backend/drizzle.config.ts /app/backend/
COPY --from=builder /app/shared /app/shared
COPY --from=builder /app/package*.json /app/
COPY --from=builder /app/backend/package*.json /app/backend/
COPY --from=builder /app/shared/package*.json /app/shared/

# 复制配置文件和生成脚本
COPY --from=builder /app/generate-env.js /app/
COPY --from=builder /app/start-all.js /app/
COPY backend/.env.example /app/backend/

# 创建必要的目录
RUN mkdir -p /app/backend/data /app/backend/uploads /app/backend/thumbnails

# 安装生产依赖
RUN npm ci --workspaces --only=production

# 暴露端口
EXPOSE 3000 3001

# 启动脚本：集成一键启动功能
CMD ["node", "/app/start-all.js", "--docker", "--mode=production"]