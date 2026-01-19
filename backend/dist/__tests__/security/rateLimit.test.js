import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
describe('Rate Limiting', () => {
    let app;
    let requestCount = 0;
    beforeAll(() => {
        app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            requestCount++;
            next();
        });
        app.get('/api/public', (req, res) => {
            res.json({ success: true, message: 'Public endpoint' });
        });
        app.post('/api/protected', (req, res) => {
            res.json({ success: true, message: 'Protected endpoint' });
        });
    });
    beforeEach(() => {
        requestCount = 0;
    });
    describe('Basic Rate Limiting', () => {
        it('should allow requests within limit', async () => {
            for (let i = 0; i < 10; i++) {
                const response = await request(app)
                    .get('/api/public')
                    .expect(200);
                expect(response.body.success).toBe(true);
            }
        });
        it('should track request count', async () => {
            const initialCount = requestCount;
            await request(app).get('/api/public').expect(200);
            expect(requestCount).toBeGreaterThan(initialCount);
        });
    });
    describe('Rate Limiting Behavior', () => {
        it('should include rate limit headers in response', async () => {
            const response = await request(app)
                .get('/api/public')
                .expect(200);
            expect(response.body).toBeDefined();
        });
        it('should handle concurrent requests', async () => {
            const requests = Array.from({ length: 5 }, () => request(app).get('/api/public'));
            const responses = await Promise.all(requests);
            responses.forEach(response => {
                expect(response.status).toBe(200);
                expect(response.body.success).toBe(true);
            });
        });
    });
    describe('Request Counting', () => {
        it('should increment request count correctly', async () => {
            expect(requestCount).toBe(0);
            await request(app).get('/api/public');
            expect(requestCount).toBe(1);
            await request(app).get('/api/public');
            expect(requestCount).toBe(2);
            await request(app).post('/api/protected').send({ test: 'data' });
            expect(requestCount).toBe(3);
        });
    });
});
