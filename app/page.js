import Script from "next/script";

export const dynamic = "force-static";

// Files in public/ are not content-hashed by the static export. Bump this with every deploy
// so the page and the client modules stay in lockstep.
const publicClientVersion = "20260930-initial-port";

function Icon({ name, size = 18 }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    pulse: <path d="M3 12h4l2-6 4 12 2-6h6" />,
    download: (
      <>
        <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
        <path d="M5 19h14" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.7 9a2.4 2.4 0 1 1 3.2 2.27c-.64.26-.9.73-.9 1.48V13M12 17h.01" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
      </>
    ),
    fan: (
      <>
        <circle cx="12" cy="12" r="2" />
        <path d="M12 10c0-4 1-7 4-7s2 5-4 7ZM14 12c4 0 7 1 7 4s-5 2-7-4ZM12 14c0 4-1 7-4 7s-2-5 4-7ZM10 12c-4 0-7-1-7-4s5-2 7 4Z" />
      </>
    ),
    flask: <path d="M9 3h6M10 3v6L4.5 18.5A1.6 1.6 0 0 0 5.9 21h12.2a1.6 1.6 0 0 0 1.4-2.5L14 9V3" />,
    book: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22.5z" />
        <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5a2.5 2.5 0 0 1 2.5 2.5z" />
      </>
    )
  };
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Dialog({ id, eyebrow, title, small = false }) {
  return (
    <dialog className={`modal${small ? " small" : ""}`} id={id} aria-labelledby={`${id}Title`}>
      <div className="modal-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 id={`${id}Title`}>{title}</h2>
        </div>
        <button className="icon-button modal-close" type="button" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="modal-body" data-role="body" />
      <div className="modal-actions" data-role="actions" />
    </dialog>
  );
}

export default function Page() {
  return (
    <>
      <noscript>
        <div className="unsupported card">
          <h1>JavaScript is required</h1>
          <p>The Gauge Serial Communicator runs entirely in your browser and needs JavaScript enabled.</p>
        </div>
      </noscript>

      <div className="unsupported card" id="unsupported" hidden>
        <h1>This browser cannot talk to serial ports</h1>
        <p>
          The Gauge Serial Communicator uses the Web Serial API, which only desktop Chrome and Microsoft Edge implement.
          Firefox and Safari do not. Open this page in a current Chrome or Edge, or use the desktop{" "}
          <a href="https://github.com/hipstereclipse/CustomSerialCommunicator">CustomSerialCommunicator</a>.
        </p>
        <p className="hint">
          You can still explore the tool without hardware: <button className="button small" id="unsupportedDemo" type="button">Try the demo</button>
        </p>
      </div>

      <div className="app" id="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="pulse" />
            </span>
            <span>
              Gauge Serial Communicator
              <small>INFICON gauges over Web Serial</small>
            </span>
          </div>
          <div className="grow" />
          <label className="row" title="Display unit. Changing it never writes to a gauge.">
            <span className="field-label">Units</span>
            <select id="unitSelect" aria-label="Display unit" />
          </label>
          <input className="session-name" id="sessionName" type="text" aria-label="Session name" />
          <span className="autosave-dot" id="autosaveDot" data-on="true" title="Autosave to this browser (IndexedDB)">
            Autosave
          </span>
          <button className="icon-button" id="themeToggle" type="button" aria-label="Toggle light and dark theme" title="Theme">
            <Icon name="sun" />
          </button>
          <button className="button" id="sessionsButton" type="button">
            <Icon name="database" /> Sessions
          </button>
          <button className="button" id="exportButton" type="button">
            <Icon name="download" /> Export
          </button>
          <button className="icon-button" id="helpButton" type="button" aria-label="Help" title="Help">
            <Icon name="help" />
          </button>
        </header>

        <div id="bannerRegion" />

        <div className="workspace">
          <aside className="rail" aria-label="Devices">
            <h2>Devices</h2>
            <div id="deviceList" />
            <div className="rail-actions">
              <button className="button primary" id="addGaugeButton" type="button">
                <Icon name="plus" /> Add gauge
              </button>
              <button className="button" id="simulateButton" type="button">
                <Icon name="flask" /> Simulate
              </button>
              <button className="button" id="turboButton" type="button">
                <Icon name="fan" /> Turbo
              </button>
              <button className="button ghost" id="demoButton" type="button">
                Try demo
              </button>
            </div>
          </aside>

          <main className="main">
            <nav className="tabs" id="tabs" role="tablist" aria-label="Workspaces" />
            <section id="panels" />
          </main>
        </div>

        <footer className="footer">
          <span>
            Local-first: serial traffic and sessions stay in this browser. No analytics. Independent utility — verify
            behavior against the official manual for your gauge and firmware.
          </span>
          <span id="buildInfo" />
        </footer>
      </div>

      <Dialog id="addGaugeDialog" eyebrow="Connect" title="Add gauge" />
      <Dialog id="simulateDialog" eyebrow="Simulation" title="Add simulated gauge" />
      <Dialog id="confirmDialog" eyebrow="Confirm" title="Send command" small />
      <Dialog id="exportDialog" eyebrow="Download" title="Export" small />
      <Dialog id="sessionsDialog" eyebrow="IndexedDB" title="Saved sessions" small />
      <Dialog id="helpDialog" eyebrow="Help" title="How this tool works" />
      <Dialog id="dictionaryDialog" eyebrow="Command dictionary" title="Commands" />

      <div className="toast-region" id="toastRegion" aria-live="polite" />
      <Script src={`./app.js?v=${publicClientVersion}`} type="module" strategy="afterInteractive" />
    </>
  );
}
