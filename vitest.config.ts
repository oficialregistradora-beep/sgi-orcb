import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // Os testes de integração compartilham um único banco de testes: execução sequencial por arquivo.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
