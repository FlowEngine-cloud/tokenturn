import Link from "next/link";
import type { ComponentType } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Every page's empty state points at the next action (spec 10). */
export function EmptyState({
  icon: Icon,
  title,
  body,
  actionHref,
  actionLabel,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" />
      <h2 className="mt-4 text-lg font-medium">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      {actionHref && actionLabel && (
        <Link href={actionHref} className={cn(buttonVariants(), "mt-5")}>
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
