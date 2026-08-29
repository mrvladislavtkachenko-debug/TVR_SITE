import { describe, expect, it } from 'vitest';
import { createShutdownSignal, startWorker } from '../src/index.js';

describe('worker shutdown', () => {
  it('startWorker резолвится по stop() и вызывает onShutdown', async () => {
    let cleaned = false;
    const runtime = startWorker({
      signal: createShutdownSignal(),
      onShutdown: () => {
        cleaned = true;
      },
    });
    runtime.stop('SIGTERM');
    await runtime.done;
    expect(cleaned).toBe(true);
  });

  it('повторный stop() безопасен', async () => {
    const runtime = startWorker({ signal: createShutdownSignal() });
    runtime.stop();
    runtime.stop();
    await runtime.done; // не должно зависнуть или упасть
  });

  it('ошибка в onShutdown не отклоняет done', async () => {
    const runtime = startWorker({
      signal: createShutdownSignal(),
      onShutdown: () => {
        throw new Error('cleanup failed');
      },
    });
    runtime.stop();
    await expect(runtime.done).resolves.toBeUndefined();
  });
});
