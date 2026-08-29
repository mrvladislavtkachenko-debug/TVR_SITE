import { describe, expect, it } from 'vitest';
import { enqueueOutbox, getOutboxStatus } from '@tas/db/services';
import { createScannerState, processOutboxJob, scanOutbox, type OutboxWorkerDeps } from '../src/outboxWorker.js';
import { WorkerFakeDb } from './helpers/workerFakeDb.js';
import { FakeTransport, MemoryLogger } from '../../bot/test/helpers/harness.js';

/** Сканер outbox: захват due-строк → BullMQ-джобы с пейсингом 1/s на чат. */

function makeDeps(db: WorkerFakeDb): { deps: OutboxWorkerDeps; added: { id: string; delay: number }[] } {
  const added: { id: string; delay: number }[] = [];
  const deps: OutboxWorkerDeps = {
    executor: db.executor,
    transport: new FakeTransport(),
    log: new MemoryLogger(),
    queue: {
      async add(_name, data, opts) {
        const d = data as { rowId: string };
        added.push({ id: `ob-${d.rowId}`, delay: Number(opts.delay ?? 0) });
        return undefined;
      },
    },
    workerRef: () => undefined,
    dailyCap: 1,
  };
  return { deps, added };
}

describe('scanOutbox (пейсинг 1/s на чат, jobId-дедуп)', () => {
  it('захват due-строк: джобы ob:{id}; второй чат не ждёт первого', async () => {
    const db = new WorkerFakeDb();
    await enqueueOutbox(db.executor, [
      { userId: '1', kind: 'transactional', payload: { chat_id: '111', text: 'a' } },
      { userId: '1', kind: 'transactional', payload: { chat_id: '222', text: 'b' } },
    ]);
    const { deps, added } = makeDeps(db);
    const res = await scanOutbox(deps, createScannerState());
    expect(res).toEqual({ claimed: 2, scheduled: 2, deferred: 0 });
    expect(added.map((a) => a.delay)).toEqual([0, 0]);
    expect(added[0]!.id).toBe(`ob-${db.outbox[0]!.id}`);
  });

  it('два сообщения одному чату: вторая джоба с delay ≥ 1s (пейсинг)', async () => {
    const db = new WorkerFakeDb();
    await enqueueOutbox(db.executor, [
      { userId: '1', kind: 'transactional', payload: { chat_id: '111', text: 'a' } },
      { userId: '1', kind: 'transactional', payload: { chat_id: '111', text: 'b' } },
    ]);
    const { deps, added } = makeDeps(db);
    const res = await scanOutbox(deps, createScannerState());
    expect(res.deferred).toBe(1);
    expect(added[1]!.delay).toBeGreaterThanOrEqual(900);
  });

  it('рестарт-пейсинг: недавняя отправка в чат (sent_at в БД) даёт delay', async () => {
    const db = new WorkerFakeDb();
    await enqueueOutbox(db.executor, [
      { userId: '1', kind: 'transactional', payload: { chat_id: '111', text: 'a' } },
    ]);
    db.outbox[0]!.status = 'sent';
    db.outbox[0]!.sent_at = new Date(Date.now() - 200); // 0.2s назад
    await enqueueOutbox(db.executor, [
      { userId: '1', kind: 'transactional', payload: { chat_id: '111', text: 'b' } },
    ]);
    const { deps, added } = makeDeps(db);
    await scanOutbox(deps, createScannerState());
    expect(added[0]!.delay).toBeGreaterThanOrEqual(700); // остаток до 1s
  });

  it('processOutboxJob: не-sending строка пропускается (джоба-дубль после каскада)', async () => {
    const db = new WorkerFakeDb();
    await enqueueOutbox(db.executor, [{ userId: '1', kind: 'transactional', payload: { chat_id: '111', text: 'a' } }]);
    const rowId = db.outbox[0]!.id;
    db.outbox[0]!.status = 'skipped';
    const { deps } = makeDeps(db);
    const out = await processOutboxJob(deps, { rowId });
    expect(out).toBe('skipped');
    expect((await getOutboxStatus(db.executor, rowId))).toBe('skipped');
  });
});
