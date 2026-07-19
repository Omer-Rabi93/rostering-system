import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Table } from './Table';
import type { Column } from './Table';

type Person = { id: number; name: string; hours: number };

const columns: Column<Person>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'hours', header: 'Hours', sortable: true, align: 'right' },
];

const rows: Person[] = [
  { id: 1, name: 'Alice', hours: 12 },
  { id: 2, name: 'Bob', hours: 8 },
];

describe('Table', () => {
  it('calls onSortChange with the column key when a sortable header button is clicked', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();

    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        onSortChange={onSortChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Name' }));

    expect(onSortChange).toHaveBeenCalledWith('name');
  });

  it('sets aria-sort on the th matching the current sort, and "none" on other sortable columns', () => {
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        sort={{ key: 'hours', direction: 'desc' }}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
      'aria-sort',
      'none',
    );
    expect(screen.getByRole('columnheader', { name: 'Hours' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('does not render a sort button or aria-sort for non-sortable columns', () => {
    const mixedColumns: Column<Person>[] = [
      { key: 'name', header: 'Name', sortable: true },
      { key: 'hours', header: 'Hours' },
    ];

    render(<Table columns={mixedColumns} rows={rows} rowKey={(row) => row.id} />);

    const hoursHeader = screen.getByRole('columnheader', { name: 'Hours' });
    expect(hoursHeader).not.toHaveAttribute('aria-sort');
    expect(screen.queryByRole('button', { name: 'Hours' })).not.toBeInTheDocument();
  });

  it('renders emptyState instead of data rows when rows is empty', () => {
    render(
      <Table
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        emptyState={<span>No people yet</span>}
      />,
    );

    expect(screen.getByText('No people yet')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('uses the custom render function for a column when provided', () => {
    const customColumns: Column<Person>[] = [
      { key: 'name', header: 'Name' },
      {
        key: 'hours',
        header: 'Hours',
        align: 'right',
        render: (row) => <strong>{row.hours} hrs</strong>,
      },
    ];

    render(<Table columns={customColumns} rows={rows} rowKey={(row) => row.id} />);

    expect(screen.getByText('12 hrs')).toBeInTheDocument();
    expect(screen.getByText('8 hrs')).toBeInTheDocument();
  });

  it('renders a caption, footer, and rowActions column together, unvirtualized', () => {
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        caption="2 people"
        footer={
          <tr>
            <td>Total</td>
            <td className="num">20</td>
          </tr>
        }
        rowActions={(row) => <button type="button">{`Edit ${row.name}`}</button>}
      />,
    );

    expect(screen.getByText('2 people')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Alice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Bob' })).toBeInTheDocument();
    // A plain (non-virtualized) table mounts one real <tr> per row -- no `data-index` spacer
    // bookkeeping.
    const dataRows = screen.getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
    expect(dataRows).toHaveLength(0);
  });

  describe('virtualized', () => {
    type Row = { id: number; name: string; hours: number };
    const virtualColumns: Column<Row>[] = [
      { key: 'name', header: 'Name', sortable: true },
      { key: 'hours', header: 'Hours', sortable: true, align: 'right' },
    ];

    function makeRows(count: number): Row[] {
      return Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Person ${i + 1}`, hours: i }));
    }

    it('is off by default -- an unset `virtualized` prop behaves exactly like `virtualized={false}`', () => {
      const manyRows = makeRows(500);
      render(<Table columns={virtualColumns} rows={manyRows} rowKey={(row) => row.id} />);

      // Every row is a real, mounted <tr> when virtualization isn't opted into, regardless of
      // count -- confirms the default path is completely unaffected by the new feature existing.
      expect(screen.getAllByText(/^Person \d+$/)).toHaveLength(500);
      const dataRows = screen.getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
      expect(dataRows).toHaveLength(0);
    });

    it('mounts only a small, bounded number of rows out of 5,000 when virtualized', () => {
      const manyRows = makeRows(5000);
      render(<Table columns={virtualColumns} rows={manyRows} rowKey={(row) => row.id} virtualized />);

      const renderedRows = screen.getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
      expect(renderedRows.length).toBeGreaterThan(0);
      // Generous bound: comfortably covers the visible window + overscan on both sides, but is
      // nowhere near the 5,000 total rows -- the actual proof that windowing is happening.
      expect(renderedRows.length).toBeLessThan(50);

      // Not every row's text is in the document -- most of the 5,000 rows were never mounted.
      expect(screen.queryByText('Person 4999')).not.toBeInTheDocument();
    });

    it('preserves sortable headers, the rowActions column, emptyState, caption, and footer when virtualized', async () => {
      const user = userEvent.setup();
      const onSortChange = vi.fn();
      const manyRows = makeRows(200);

      render(
        <Table
          columns={virtualColumns}
          rows={manyRows}
          rowKey={(row) => row.id}
          virtualized
          sort={{ key: 'hours', direction: 'asc' }}
          onSortChange={onSortChange}
          caption="200 people"
          footer={
            <tr>
              <td>Total</td>
              <td className="num">199</td>
            </tr>
          }
          rowActions={(row) => <button type="button">{`Edit ${row.name}`}</button>}
        />,
      );

      expect(screen.getByText('200 people')).toBeInTheDocument();
      expect(screen.getByText('Total')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Hours' })).toHaveAttribute('aria-sort', 'ascending');

      await user.click(screen.getByRole('button', { name: 'Name' }));
      expect(onSortChange).toHaveBeenCalledWith('name');

      // At least one rendered row's action button is present -- rowActions still wired per-row.
      expect(screen.getByRole('button', { name: 'Edit Person 1' })).toBeInTheDocument();
    });

    it('renders emptyState (not a virtualized window) when rows is empty, even with virtualized set', () => {
      render(
        <Table
          columns={virtualColumns}
          rows={[]}
          rowKey={(row) => row.id}
          virtualized
          emptyState={<span>No people yet</span>}
        />,
      );

      expect(screen.getByText('No people yet')).toBeInTheDocument();
      expect(screen.queryByRole('row', { name: /Person/ })).not.toBeInTheDocument();
    });
  });
});
