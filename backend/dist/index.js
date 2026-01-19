import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cookieParser from 'cookie-parser';
import { authRouter } from './controllers/auth.controller.js';
import { userRouter } from './controllers/user.controller.js';
import { projectRouter } from './controllers/project.controller.js';
import { canvasRouter } from './controllers/canvas.controller.js';
import { logRouter } from './controllers/log.routes.js';
import { uploadRouter } from './controllers/upload.controller.js';
import { apiLimiter } from './middleware/rateLimit.middleware.js';
import { csrfProtectionMiddleware, getCsrfTokenRoute } from './middleware/csrf.middleware.js';
import { setupWebSocket } from './websocket/index.js';
import { errorHandler } from './middleware/error.middleware.js';
import { initDatabase } from './database/init.js';
import { getValidatedEnv } from './utils/env.js';
const app = express();
const server = createServer(app);
const env = getValidatedEnv();
const PORT = parseInt(env.PORT || '3000', 10);
const WS_PORT = parseInt(env.WS_PORT || '3001', 10);
import { createCorsMiddleware } from './middleware/cors.middleware.js';
app.use(createCorsMiddleware(env));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'mindmap-backend',
        version: '1.0.0'
    });
});
app.get('/api/csrf-token', apiLimiter(), getCsrfTokenRoute);
app.use('/api/auth', apiLimiter(), authRouter);
app.use('/api/users', apiLimiter(), csrfProtectionMiddleware, userRouter);
app.use('/api/projects', apiLimiter(), csrfProtectionMiddleware, projectRouter);
app.use('/api/canvases', apiLimiter(), csrfProtectionMiddleware, canvasRouter);
app.use('/api/logs', logRouter);
app.use('/api/upload', apiLimiter(), csrfProtectionMiddleware, uploadRouter);
const frontendDistPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDistPath));
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
});
app.use(errorHandler);
async function start() {
    try {
        console.log('Initializing application...');
        await initDatabase();
        console.log('Application initialization complete');
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`HTTP Server running on port ${PORT}`);
        });
        const wsServer = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });
        setupWebSocket(wsServer);
        console.log(`WebSocket Server running on port ${WS_PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`Application ready at http://localhost:${PORT}`);
        console.log(`CORS configured with ALLOWED_ORIGINS: ${process.env.ALLOWED_ORIGINS || 'localhost'}`);
    }
    catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}
start();
