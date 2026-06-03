// Small reusable pager for the rep-detail activity tables. Renders nothing when everything fits
// on one page, so small tables look exactly as before.
export function Pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const start = (page - 1) * pageSize + 1;
  const end   = Math.min(page * pageSize, total);
  const btn = "px-2 py-1 rounded text-[10px] font-mono border border-border disabled:opacity-40 "
            + "disabled:cursor-not-allowed hover:bg-surface2 transition-colors";
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
      <span className="text-[10px] text-muted font-mono">{start}–{end} of {total}</span>
      <div className="flex items-center gap-2">
        <button className={btn} disabled={page <= 1}     onClick={() => onPage(page - 1)}>‹ Prev</button>
        <span className="text-[10px] text-muted font-mono">Page {page} / {pages}</span>
        <button className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
      </div>
    </div>
  );
}
