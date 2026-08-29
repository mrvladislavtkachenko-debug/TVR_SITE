/**
 * Управляемый сигнал завершения: отвязан от реальных сигналов процесса,
 * чтобы быть тестируемым. index.ts подписывает process-хендлеры на trigger().
 */
export interface ShutdownSignal {
  readonly promise: Promise<void>;
  trigger(reason?: string): void;
}

export function createShutdownSignal(): ShutdownSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return {
    promise,
    trigger(reason?: string) {
      if (reason !== undefined) {
        // причина логируется вызывающим кодом; здесь — просто контракт
      }
      resolve();
    },
  };
}

export interface WorkerRuntime {
  /** Резолвится после trigger() и завершения onShutdown. */
  readonly done: Promise<void>;
  stop(reason?: string): void;
}

/**
 * Каркас воркера M1: keep-alive + graceful shutdown.
 * BullMQ-воркеры (flows, outbox sender) подключаются в M6.
 */
export function startWorker(opts: {
  signal: ShutdownSignal;
  onShutdown?: () => void | Promise<void>;
  keepAliveMs?: number;
}): WorkerRuntime {
  const { signal, onShutdown, keepAliveMs = 60_000 } = opts;
  // держит event-loop живым; останавливается при shutdown
  const keepAlive = setInterval(() => {}, keepAliveMs);

  const done = (async () => {
    await signal.promise;
    clearInterval(keepAlive);
    try {
      await onShutdown?.();
    } catch {
      // ошибки очистки не должны мешать завершению
    }
  })();

  return {
    done,
    stop(reason?: string) {
      signal.trigger(reason);
    },
  };
}
