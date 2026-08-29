import http from 'node:http';

/**
 * Мок Telegram Bot API поверх настоящего HTTP: grammY-клиент (apiRoot →
 * 127.0.0.1) проходит реальную сериализацию и парсинг ответов/ошибок.
 * Используется в webhook-тесте и live-smoke.
 */

export interface TgCall {
  method: string;
  body: Record<string, unknown>;
}

export interface MockFail {
  /** подстрока метода, напр. 'sendDocument' */
  match: string;
  code: number;
  description: string;
  retryAfterSeconds?: number;
}

export class MockTelegramServer {
  calls: TgCall[] = [];
  fails: MockFail[] = [];
  port = 0;
  private server: http.Server | null = null;
  private seq = 4000;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      req.on('end', () => {
        const method = decodeURIComponent(req.url ?? '').split('/').pop() ?? '';
        let body: Record<string, unknown> = {};
        try {
          body = data === '' ? {} : (JSON.parse(data) as Record<string, unknown>);
        } catch {
          // пустое тело допустимо
        }
        this.calls.push({ method, body });
        const failIndex = this.fails.findIndex((f) => method.includes(f.match));
        res.setHeader('content-type', 'application/json');
        if (failIndex >= 0) {
          const fail = this.fails.splice(failIndex, 1)[0]!;
          res.statusCode = fail.code;
          res.end(
            JSON.stringify({
              ok: false,
              error_code: fail.code,
              description: fail.retryAfterSeconds
                ? `${fail.description} (retry after ${fail.retryAfterSeconds})`
                : fail.description,
              ...(fail.retryAfterSeconds
                ? { parameters: { retry_after: fail.retryAfterSeconds } }
                : {}),
            }),
          );
          return;
        }
        this.seq += 1;
        const result =
          method === 'answerCallbackQuery'
            ? true
            : method === 'setWebhook'
              ? true
              : { message_id: this.seq, chat: { id: body.chat_id ?? 0 }, date: Math.floor(Date.now() / 1000) };
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock telegram: no port');
    this.port = addr.port;
    return this.apiRoot;
  }

  get apiRoot(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  methodCalls(method: string): TgCall[] {
    return this.calls.filter((c) => c.method ===(method));
  }
}
