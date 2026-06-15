"use client";

import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { START_TOUR_EVENT } from "@/components/shell/tour";

/** Re-runs the product tour from the start (the controller lives in the
 * dashboard layout and listens for this event). */
export function ReplayTourButton() {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => window.dispatchEvent(new Event(START_TOUR_EVENT))}
    >
      <Compass className="h-4 w-4" />
      Replay tour
    </Button>
  );
}
