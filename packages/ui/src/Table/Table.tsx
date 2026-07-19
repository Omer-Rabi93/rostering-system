import { useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

// Design note: `T` is a fully generic row shape with no guaranteed structure, so a column
// cannot safely read an arbitrary `col.key` off a row without `any`/non-null assertions. We
// resolve this by constraining `key` to `keyof T & string`: every column key must be a real,
// string-named property of `T`. That keeps `row[col.key]` fully type-checked (no `any`, no
// assertions) while still letting callers override the rendered content via `render`.
export type Column<T> = {
  key: keyof T & string;
  header: string;
  sortable?: boolean;
  align?: 'left' | 'right';
  render?: (row: T) => ReactNode;
};

export type TableSort = {
  key: string;
  direction: 'asc' | 'desc';
};

export type TableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  sort?: TableSort;
  onSortChange?: (key: string) => void;
  emptyState?: ReactNode;
  caption?: string;
  footer?: ReactNode;
  rowActions?: (row: T) => ReactNode;
  /**
   * Opt-in row virtualization (windowing), via `@tanstack/react-virtual` — OFF by default. Every
   * `Table` consumer except `WorkersPage` (Companies, Cost Dashboard, ...) has a small, bounded
   * row count and gets the exact same DOM/behavior as before regardless of this prop's existence;
   * only a consumer whose row count can genuinely grow large (`WorkersPage`, scoped to a company's
   * full active workforce — up to 1,000-10,000 rows on the backend's current scale) should pass
   * `true`. When enabled, `rows` are windowed inside a fixed-height, independently-scrolling
   * container (only rows within the visible window + a small overscan are ever mounted) instead of
   * every row being rendered and the whole page growing to fit them all.
   */
  virtualized?: boolean;
  /** Only meaningful when `virtualized` is true: the scrollable window's max height in pixels.
   * Defaults to a reasonable list-page height; override to fit the surrounding layout. */
  virtualizedHeight?: number;
};

const DEFAULT_VIRTUALIZED_HEIGHT = 480;
// Initial guess only, used before any row has actually been measured — corrected per-row by
// `measureElement` below (each rendered `<tr>`'s real `offsetHeight`) once the table has rendered
// at least once. Derived from `.data-table th, .data-table td`'s own `var(--space-3)` (12px)
// top/bottom padding plus one `--text-sm` line and the 1px bottom border.
const ROW_HEIGHT_ESTIMATE = 44;

export function Table<T>(props: TableProps<T>): ReactElement {
  const {
    columns,
    rows,
    rowKey,
    sort,
    onSortChange,
    emptyState,
    caption,
    footer,
    rowActions,
    virtualized = false,
    virtualizedHeight = DEFAULT_VIRTUALIZED_HEIGHT,
  } = props;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 10,
    enabled: virtualized,
  });

  const colSpan = columns.length + (rowActions ? 1 : 0);

  function renderRowCells(row: T): ReactElement {
    return (
      <>
        {columns.map((col) => (
          <td key={col.key} className={col.align === 'right' ? 'num' : undefined}>
            {col.render ? col.render(row) : String(row[col.key])}
          </td>
        ))}
        {rowActions ? <td className="row-actions">{rowActions(row)}</td> : null}
      </>
    );
  }

  let body: ReactNode;
  if (rows.length === 0) {
    body = (
      <tbody>
        <tr>
          <td colSpan={colSpan}>{emptyState}</td>
        </tr>
      </tbody>
    );
  } else if (virtualized) {
    const virtualRows = rowVirtualizer.getVirtualItems();
    const totalSize = rowVirtualizer.getTotalSize();
    const firstItem = virtualRows[0];
    const lastItem = virtualRows[virtualRows.length - 1];
    const paddingTop = firstItem ? firstItem.start : 0;
    const paddingBottom = lastItem ? totalSize - lastItem.end : 0;

    body = (
      <tbody>
        {/* Spacer rows stand in for the un-rendered rows above/below the virtualized window, so
            the scroll container's scrollbar/height still reflects all `rows.length` rows even
            though only `virtualRows.length` `<tr>`s actually exist in the DOM. Real `<tr>`s stay
            in normal table flow (nothing is absolutely positioned), so column alignment and the
            sticky `thead th` rule below (`.data-table thead th { position: sticky; top: 0 }`,
            already unconditional) keep working unmodified. */}
        {paddingTop > 0 ? (
          <tr aria-hidden="true">
            <td style={{ height: paddingTop, padding: 0, border: 'none' }} colSpan={colSpan} />
          </tr>
        ) : null}
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <tr key={rowKey(row)} data-index={virtualRow.index} ref={rowVirtualizer.measureElement}>
              {renderRowCells(row)}
            </tr>
          );
        })}
        {paddingBottom > 0 ? (
          <tr aria-hidden="true">
            <td style={{ height: paddingBottom, padding: 0, border: 'none' }} colSpan={colSpan} />
          </tr>
        ) : null}
      </tbody>
    );
  } else {
    body = (
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>{renderRowCells(row)}</tr>
        ))}
      </tbody>
    );
  }

  return (
    <div
      className={virtualized ? 'table-wrap table-wrap--virtualized' : 'table-wrap'}
      ref={scrollContainerRef}
      style={virtualized ? { maxHeight: virtualizedHeight } : undefined}
    >
      <table className="data-table">
        {caption !== undefined ? <caption className="visually-hidden">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((col) => {
              const isSorted = sort !== undefined && sort.key === col.key;
              const ariaSort = col.sortable
                ? isSorted
                  ? sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
                : undefined;

              return (
                <th
                  key={col.key}
                  className={col.align === 'right' ? 'num' : undefined}
                  aria-sort={ariaSort}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => onSortChange?.(col.key)}
                    >
                      {col.header}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
            {rowActions ? <th /> : null}
          </tr>
        </thead>
        {body}
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}
