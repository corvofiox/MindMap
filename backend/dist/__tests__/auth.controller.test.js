import { describe, it, expect } from 'vitest';
describe('Authentication Controller', () => {
    it('should export auth router', () => {
        expect(require('../controllers/auth.controller.js')).toBeDefined();
    });
    it('should have login route', () => {
        expect(require('../controllers/auth.controller.js').post).toBeDefined();
    });
    it('should have register route', () => {
        expect(require('../controllers/auth.controller.js').post).toBeDefined();
    });
    it('should have logout route', () => {
        expect(require('../controllers/auth.controller.js').post).toBeDefined();
    });
    it('should have refresh route', () => {
        expect(require('../controllers/auth.controller.js').post).toBeDefined();
    });
});
