export function runMigrations(opts: {
  databaseUrl: string | undefined;
  dir: string;
  startupTimeoutMs?: number;
}): Promise<string[]>;
