import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { doubleCsrf } from 'csrf-csrf';
import cookieParser from 'cookie-parser';
describe('CSRF Protection', () => {
    let app;
    let csrfToken;
    beforeAll(() => {
        app = express();
        app.use(cookieParser());
        app.use(express.json());
        const { doubleCsrfProtection } = doubleCsrf({
            getSecret: () => 'test-secret-key-for-testing',
            getSessionIdentifier: (req) => req.sessionID || req.ip || 'test-session',
            cookieName: 'x-csrf-token',
            cookieOptions: {
                secure: false,
                sameSite: 'strict',
                httpOnly: true,
                maxAge: 86400
            },
            size: 64,
            ignoredMethods: ['GET', 'HEAD', 'OPTIONS']
        });
        app.get('/api/csrf-token', doubleCsrfProtection, (req, res) => {
            const token = res.locals.csrfToken || req.csrfToken();
            res.json({ success: true, token });
        });
        app.post('/api/protected', doubleCsrfProtection, (req, res) => {
            res.json({ success: true, message: 'CSRF protection passed' });
        });
        app.get('/api/public', (req, res) => {
            res.json({ success: true, message: 'Public endpoint' });
        });
    });
    describe('CSRF Token Generation', () => {
        it('should generate CSRF token', async () => {
            const response = await request(app)
                .get('/api/csrf-token')
                .expect(200);
            expect(response.body.success).toBe(true);
            expect(response.body.token).toBeDefined();
            expect(typeof response.body.token).toBe('string');
            csrfToken = response.body.token;
        });
        it('should set CSRF cookie', async () => {
            const response = await request(app)
                .get('/api/csrf-token')
                .expect(200);
            const cookies = response.headers['set-cookie'];
            expect(cookies).toBeDefined();
            const cookieArray = Array.isArray(cookies) ? cookies : [cookies];
            const hasCsrfCookie = cookieArray.some(cookie => cookie.includes('x-csrf-token'));
            expect(hasCsrfCookie).toBe(true);
        });
    });
    describe('CSRF Token Validation', () => {
        it('should accept valid CSRF token', async () => {
            const tokenResponse = await request(app)
                .get('/api/csrf-token')
                .expect(200);
            const token = tokenResponse.body.token;
            const cookies = tokenResponse.headers['set-cookie'];
            const response = await request(app)
                .post('/api/protected')
                .set('Cookie', cookies)
                .set('x-csrf-token', token)
                .send({ data: 'test' })
                .expect(200);
            expect(response.body.success).toBe(true);
            expect(response.body.message).toBe('CSRF protection passed');
        });
        it('should reject missing CSRF token', async () => {
            const response = await request(app)
                .post('/api/protected')
                .send({ data: 'test' });
            expect(response.status).toBe(403);
        });
        it('should reject invalid CSRF token', async () => {
            const response = await request(app)
                .post('/api/protected')
                .set('x-csrf-token', 'invalid-token')
                .send({ data: 'test' });
            expect(response.status).toBe(403);
        });
    });
    describe('Public Endpoint Access', () => {
        it('should allow GET requests without CSRF token', async () => {
            const response = await request(app)
                .get('/api/public')
                .expect(200);
            expect(response.body.success).toBe(true);
            expect(response.body.message).toBe('Public endpoint');
        });
    });
});
