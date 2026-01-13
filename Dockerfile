# syntax=docker/dockerfile:1

ARG NODE_VERSION=20-alpine

FROM node:${NODE_VERSION}

WORKDIR /app

ENV NODE_ENV=production
ENV DOCKER_CONTAINER=true

RUN apk add --no-cache python3 make g++ vips-dev curl

COPY package.json package-lock.json* start.js ./

COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend

RUN npm install --include=dev && \
    npm install --workspaces --include=dev

RUN node start.js --env-only

RUN cd backend && npm run build && \
    cd ../frontend && npm run build

RUN npm prune --omit=dev && \
    npm install --workspaces --omit=dev

RUN apk add --no-cache python3 make g++ && \
    npm rebuild bcrypt && \
    cd backend && npm rebuild bcrypt && \
    cd .. && apk del python3 make g++

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
