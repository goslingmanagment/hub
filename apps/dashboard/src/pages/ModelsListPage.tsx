import { useNavigate } from "react-router";
import { useOverview } from "@/api/queries";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { MoneyCell } from "@/components/shared/MoneyCell";
import { SkeletonTable } from "@/components/shared/SkeletonTable";

export function ModelsListPage() {
  const { data, isLoading } = useOverview();
  const navigate = useNavigate();

  if (isLoading) return <SkeletonTable />;

  // Group pages by model
  const models = new Map<string, { slug: string; name: string; pages: any[]; revenue7d: number; revenue30d: number }>();
  for (const page of data?.pages ?? []) {
    const key = page.modelSlug;
    if (!models.has(key)) {
      models.set(key, { slug: key, name: page.modelName, pages: [], revenue7d: 0, revenue30d: 0 });
    }
    const m = models.get(key)!;
    m.pages.push(page);
    m.revenue7d += page.revenue7dMills ?? 0;
    m.revenue30d += page.revenue30dMills ?? 0;
  }

  const rows = Array.from(models.values());

  const columns: Column<typeof rows[number]>[] = [
    { key: "name", header: "Model", render: (r) => <span className="font-medium text-zinc-100">{r.name}</span> },
    { key: "pages", header: "Pages", className: "text-right", render: (r) => r.pages.length },
    { key: "revenue7d", header: "7D Revenue", className: "text-right", render: (r) => <MoneyCell mills={r.revenue7d} /> },
    { key: "revenue30d", header: "30D Revenue", className: "text-right", render: (r) => <MoneyCell mills={r.revenue30d} /> },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">Models</h1>
      <DataTable
        columns={columns}
        data={rows}
        onRowClick={(r) => navigate(`/models/${r.slug}`)}
      />
    </div>
  );
}
