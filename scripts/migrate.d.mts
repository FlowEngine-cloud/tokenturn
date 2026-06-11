export function runMigrations(opts: {
  databaseUrl: string | undefined;
  dir: string;
}): Promise<string[]>;
