import { Suspense } from "react";
import ProductsClient, { ProductsSkeleton } from "./products-client";

/** Products (spec 10 page 3): per cost center - spend and its own metric in
 * its own unit ($/merge, $/ticket, $/user) - every row drills in. */
export default function ProductsPage() {
  return (
    <Suspense fallback={<ProductsSkeleton />}>
      <ProductsClient />
    </Suspense>
  );
}
