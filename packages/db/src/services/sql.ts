/**
 * Инъектируемый SQL-исполнитель: prod — Prisma ($queryRawUnsafe/$executeRawUnsafe
 * с параметрами), скрипты/verификация — чистый pg. Единый интерфейс держит
 * сервисы тестируемыми без Prisma-движков (TD-005).
 */
export interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

export interface SqlExecutor {
  query(sql: string, params: unknown[]): Promise<QueryResult>;
  execute(sql: string, params: unknown[]): Promise<number>;
}

/** Prod-адаптер: Prisma ($queryRawUnsafe/$executeRawUnsafe — параметризовано). */
export function prismaExecutor(prisma: {
  $queryRawUnsafe<T = unknown>(sql: string, ...params: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
}): SqlExecutor {
  return {
    async query(sql, params) {
      const rows = (await prisma.$queryRawUnsafe<unknown[]>(sql, ...params)) ?? [];
      return { rows, rowCount: rows.length };
    },
    async execute(sql, params) {
      return prisma.$executeRawUnsafe(sql, ...params);
    },
  };
}
