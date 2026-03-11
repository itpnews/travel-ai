export function SkeletonCard() {
  return (
    <div className="skeleton-card" aria-hidden="true">
      {/* Top row: label badge + source */}
      <div className="skeleton-row">
        <div className="skeleton-block" style={{ width: 80, height: 16 }} />
        <div className="skeleton-block" style={{ width: 48, height: 12, marginLeft: 'auto' }} />
      </div>
      {/* Flight row */}
      <div className="skeleton-row">
        <div className="skeleton-block" style={{ width: 60, height: 14 }} />
        <div className="skeleton-block" style={{ flex: 1, height: 24 }} />
        <div className="skeleton-block" style={{ width: 70, height: 32 }} />
      </div>
      {/* IATA row */}
      <div className="skeleton-row">
        <div className="skeleton-block" style={{ width: 36, height: 12 }} />
        <div className="skeleton-block" style={{ flex: 1, height: 10 }} />
        <div className="skeleton-block" style={{ width: 36, height: 12 }} />
      </div>
      {/* Footer */}
      <div className="skeleton-row" style={{ marginTop: 4 }}>
        <div className="skeleton-block" style={{ width: 160, height: 12 }} />
        <div className="skeleton-block" style={{ width: 80, height: 12, marginLeft: 'auto' }} />
      </div>
    </div>
  );
}
