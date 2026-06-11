export function mintResetToken(opts: {
  databaseUrl: string | undefined;
}): Promise<{ token: string; admin: { id: string; name: string } }>;
