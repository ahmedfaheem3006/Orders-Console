import { PAGE_SIZES } from "../api/orders";

interface PaginationProps {
  page: number; // the requested page (source of truth), not the last page that arrived
  pageSize: number;
  total: number;
  totalPages: number;
  loading: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

const countFormat = new Intl.NumberFormat("en-US");

export function Pagination({ page, pageSize, total, totalPages, loading, onPageChange, onPageSizeChange }: PaginationProps) {
  const summary = loading
    ? "Loading…"
    : `${countFormat.format(total)} orders · Page ${totalPages === 0 ? 0 : page} of ${countFormat.format(totalPages)}`;

  return (
    <nav className="pagination" aria-label="Pagination">
      <p className="pagination-summary" role="status" aria-live="polite">
        {summary}
      </p>

      <div className="pagination-controls">
        <label htmlFor="pageSize">Rows</label>
        <select id="pageSize" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          Previous
        </button>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
          Next
        </button>
      </div>
    </nav>
  );
}
