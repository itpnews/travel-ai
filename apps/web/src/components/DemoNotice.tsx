export function DemoNotice() {
  return (
    <div className="demo-notice" role="note">
      <div className="demo-notice-inner">
        <span>ℹ</span>
        <span>
          Using demo data —{' '}
          <a
            href="https://developers.amadeus.com/self-service"
            target="_blank"
            rel="noopener noreferrer"
          >
            add Amadeus credentials
          </a>
          {' '}to <code>.env.local</code> for live flight search.
        </span>
      </div>
    </div>
  );
}
