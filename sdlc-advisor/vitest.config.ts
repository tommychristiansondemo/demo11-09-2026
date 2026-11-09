import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['services/test/**/*.test.ts', 'test/**/*.test.ts'], testTimeout: 120_000 } });
