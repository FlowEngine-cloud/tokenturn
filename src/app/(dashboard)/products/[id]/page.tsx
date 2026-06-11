import { Suspense } from "react";
import ProductClient, { ProductSkeleton } from "./product-client";

/** One cost center (spec 10 page 3 click-through): spend by vendor, person
 * and day, outcomes in its own unit, ROI where real, keys routed to it. */
export default function ProductPage() {
  return (
    <Suspense fallback={<ProductSkeleton />}>
      <ProductClient />
    </Suspense>
  );
}
