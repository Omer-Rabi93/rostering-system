import type { ReactElement, ReactNode } from 'react';

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
};

export function Table<T>(props: TableProps<T>): ReactElement {
  const { columns, rows, rowKey, sort, onSortChange, emptyState, caption, footer, rowActions } =
    props;

  return (
    <div className="table-wrap">
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
        {rows.length === 0 ? (
          <tbody>
            <tr>
              <td colSpan={columns.length + (rowActions ? 1 : 0)}>{emptyState}</td>
            </tr>
          </tbody>
        ) : (
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((col) => (
                  <td key={col.key} className={col.align === 'right' ? 'num' : undefined}>
                    {col.render ? col.render(row) : String(row[col.key])}
                  </td>
                ))}
                {rowActions ? <td className="row-actions">{rowActions(row)}</td> : null}
              </tr>
            ))}
          </tbody>
        )}
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}
