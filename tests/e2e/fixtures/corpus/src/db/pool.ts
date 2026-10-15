export const MAX_CONNECTIONS = 12;

export function openConnectionPool(dsn: string): { query: (sql: string) => string } {
  return { query: (sql: string) => `${dsn}::${sql}` };
}
