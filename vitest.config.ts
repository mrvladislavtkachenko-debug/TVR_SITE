import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// vitest ≥ 3.2: корневой конфиг с projects (вместо vitest.workspace.ts).
// web (Next.js) тестов в M1 не имеет — появится в M3 (bridge-события).
const sharedAlias = {
  '@tas/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
};

export default defineConfig({
  resolve: {
    alias: sharedAlias,
  },
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          include: ['packages/shared/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'api',
          include: ['apps/api/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'bot',
          include: ['apps/bot/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'worker',
          include: ['apps/worker/test/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
