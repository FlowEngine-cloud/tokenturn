import { Suspense } from "react";
import { Package } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { getPool } from "@/lib/db";
import { listProducts } from "@/lib/products";
import { ProductsTable, type ProductRow } from "./products-table";

export const dynamic = "force-dynamic";

/** Cost-center shell (spec 10 page 3 lands in its own build; this lists
 * products and drills each one's spend). */
export default async function ProductsPage() {
  const products = await listProducts({ includeArchived: true }, getPool());
  const rows: ProductRow[] = products.map((p) => ({
    id: p.id,
    name: p.name,
    attribution: p.attribution,
    outcomeKind: p.outcomeKind,
    archived: p.archivedAt !== null,
  }));

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No products yet"
        body="Products are cost centers - anything that spends AI money. A key tag, the SDK, or a manual entry routes spend into one."
        actionHref="/settings"
        actionLabel="Open Settings"
      />
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Products</h1>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <ProductsTable products={rows} />
      </Suspense>
    </div>
  );
}
