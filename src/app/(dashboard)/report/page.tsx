import { FileText } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/** Spec 10 page 6 - built in its own loop. */
export default function ReportPage() {
  return (
    <EmptyState
      icon={FileText}
      title="CFO report"
      body="One printable page: spend by cost center, unit costs, ROI where defined, month over month - with CSV and FOCUS 1.4 export."
      actionHref="/"
      actionLabel="View spend"
    />
  );
}
