import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/database/schema.ts',
  out: './src/database/migrations',
  driver: 'sqlite', // Use generic sqlite driver
  dbCredentials: {
    url: process.env.DB_FILE || './data/mindmap.db',
  },
})
