import { Wrench } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/** Spec 10 page 4 - built in its own loop. */
export default function ToolsPage() {
  return (
    <EmptyState
      icon={Wrench}
      title="Tool comparisons"
      body="Cost per merged PR, accept rates, and revert rates per tool, side by side - built from Anthropic, Cursor, and GitHub analytics."
      actionHref="/settings"
      actionLabel="Open Settings"
    />
  );
}
