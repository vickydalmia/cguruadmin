import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    setupFiles: ['./src/background/test-setup.ts'],
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
});
