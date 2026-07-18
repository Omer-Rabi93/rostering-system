import type { ReactElement, ReactNode } from 'react';

export type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
};

export function EmptyState({ icon, title, body, action }: EmptyStateProps): ReactElement {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <p className="empty-state__title">{title}</p>
      {body ? <p className="empty-state__body">{body}</p> : null}
      {action ? (
        <button type="button" className="btn btn--primary" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
