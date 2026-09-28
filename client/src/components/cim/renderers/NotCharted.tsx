/**
 * NotCharted — the chart values that aren't one readable amount ("TBD",
 * "$1.1–1.2M"), listed under the chart as written. They used to be drawn
 * as a $0 bar or a vanished slice (shared/cim-chart-values chartSeriesRows).
 */
export function NotCharted({ items }: { items: Array<{ name: string; value: string }> }) {
  if (items.length === 0) return null;
  return (
    <p className="text-2xs text-muted-foreground mt-2 leading-snug" data-testid="chart-not-charted">
      {items.map((it, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {it.name ? <span className="font-medium text-foreground/80">{it.name}: </span> : null}
          {it.value}
        </span>
      ))}
    </p>
  );
}
