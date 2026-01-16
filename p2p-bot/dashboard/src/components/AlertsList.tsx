'use client';

interface Alert {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  createdAt: string;
  acknowledged: boolean;
}

const severityColors: Record<string, string> = {
  info: 'border-l-violet-400 bg-violet-500/10',
  warning: 'border-l-amber-400 bg-amber-500/10',
  error: 'border-l-red-400 bg-red-500/10',
  critical: 'border-l-red-600 bg-red-600/20',
};

const severityIcons: Record<string, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  error: '❌',
  critical: '🚨',
};

export function AlertsList({ alerts }: { alerts: Alert[] }) {
  const unacknowledged = alerts.filter((a) => !a.acknowledged);

  if (unacknowledged.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500">
        No active alerts
      </div>
    );
  }

  return (
    <div className="divide-y divide-dark-border">
      {unacknowledged.slice(0, 5).map((alert) => (
        <div
          key={alert.id}
          className={`p-4 border-l-4 ${severityColors[alert.severity] || severityColors.info}`}
        >
          <div className="flex items-start gap-3">
            <span className="text-lg">{severityIcons[alert.severity]}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {alert.title}
              </p>
              <p className="text-xs text-gray-400 mt-1 line-clamp-2">
                {alert.message}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                {new Date(alert.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
