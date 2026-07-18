import type { ReactElement } from 'react';

export type Alert = {
  id: number;
  type: 'unfillable_slot' | 'min_hours_shortfall';
  detail: string;
  acknowledged: boolean;
};

export type AlertChecklistProps = {
  alerts: Alert[];
  onAcknowledge: (alertId: number) => void;
  onJumpTo?: (alertId: number) => void;
};

export function AlertChecklist(props: AlertChecklistProps): ReactElement {
  const { alerts, onAcknowledge, onJumpTo } = props;

  return (
    <div className="alert-checklist">
      {alerts.map((alert) => {
        const checkboxId = `alert-ack-${alert.id}`;
        const severityClass = alert.type === 'unfillable_slot' ? 'blocking' : 'warning';
        const itemClass = `alert-item alert-item--${severityClass}${
          alert.acknowledged ? ' is-acked' : ''
        }`;

        return (
          <div key={alert.id} className={itemClass}>
            <input
              type="checkbox"
              id={checkboxId}
              checked={alert.acknowledged}
              onChange={() => onAcknowledge(alert.id)}
            />
            <div className="alert-item__body">
              <label className="alert-item__title" htmlFor={checkboxId}>
                Acknowledge: {alert.detail}
              </label>
            </div>
            {onJumpTo ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-label={`Jump to: ${alert.detail}`}
                onClick={() => onJumpTo(alert.id)}
              >
                Jump to
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
