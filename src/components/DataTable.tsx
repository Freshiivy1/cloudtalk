import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  /** render monospace (numbers, durations, extensions) */
  mono?: boolean;
  className?: string;
  render?: (row: T, index: number) => ReactNode;
}

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  getRowId?: (row: T, index: number) => string | number;
  onRowClick?: (row: T) => void;
  /** empty state */
  emptyImage?: string;
  emptyTitle?: string;
  emptyHint?: string;
  /** pagination footer */
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  className?: string;
}

/**
 * Shared console table: uppercase 11px headers, 52px rows with hover lift +
 * sliding signal indicator, mono columns, pagination footer, dashed empty
 * state with illustration slot.
 */
export default function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  getRowId,
  onRowClick,
  emptyImage = '/empty-calls.svg',
  emptyTitle = 'No calls yet',
  emptyHint = 'When calls come in, they will show up here.',
  page = 1,
  pageSize = 25,
  total,
  onPageChange,
  className,
}: DataTableProps<T>) {
  const totalCount = total ?? rows.length;
  const from = rows.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount, (page - 1) * pageSize + rows.length);
  const hasPrev = page > 1;
  const hasNext = total != null ? page * pageSize < total : rows.length >= pageSize;

  return (
    <div className={cn('overflow-hidden rounded-[14px] border border-line bg-ink-900', className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'px-4 py-3 text-[11px] font-medium uppercase tracking-[0.08em] text-text-low',
                    col.className
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={getRowId ? getRowId(row, i) : i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'group relative h-[52px] border-b border-line/60 transition-colors duration-150 last:border-b-0',
                  onRowClick && 'cursor-pointer hover:bg-ink-700'
                )}
              >
                {columns.map((col, ci) => (
                  <td
                    key={col.key}
                    className={cn(
                      'px-4 py-2 text-sm text-text-mid',
                      col.mono && 'font-mono text-[13px]',
                      col.className
                    )}
                  >
                    <span className="relative flex items-center">
                      {ci === 0 && onRowClick && (
                        <span className="absolute -left-4 h-5 w-[2px] rounded-full bg-signal opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                      )}
                      {col.render ? col.render(row, i) : String(row[col.key] ?? '')}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
            <div className="rounded-[14px] border border-dashed border-line p-4">
              <img src={emptyImage} alt="" className="h-24 w-auto opacity-80" />
            </div>
            <div className="text-sm font-medium text-text-hi">{emptyTitle}</div>
            <div className="max-w-xs text-xs text-text-low">{emptyHint}</div>
          </div>
        )}
      </div>

      {(total != null || rows.length > 0) && (
        <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
          <span className="font-mono text-[11px] text-text-low">
            Showing {from}–{to} of {totalCount}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={!hasPrev}
              onClick={() => onPageChange?.(page - 1)}
              className="rounded-lg p-1.5 text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi disabled:opacity-40"
              title="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              disabled={!hasNext}
              onClick={() => onPageChange?.(page + 1)}
              className="rounded-lg p-1.5 text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi disabled:opacity-40"
              title="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
