/** The help area's uniform section - a heading and muted prose, no
 * decoration (spec 10). Shared by the guide (/help) and the API
 * reference (/help/api). */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium">{title}</h2>
      <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

/** Inline code in help prose. */
export function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-foreground">{children}</code>;
}

/** A code block in help prose. */
export function Block({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border bg-card p-4 font-mono text-sm text-foreground">
      {children}
    </pre>
  );
}
