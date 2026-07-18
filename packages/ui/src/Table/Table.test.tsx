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
});
