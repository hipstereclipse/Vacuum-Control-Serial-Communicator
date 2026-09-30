import "./globals.css";

// Light is the default look (the brand's white-and-blue); a saved choice of dark wins.
const themeBootScript = `
  (() => {
    try {
      const saved = localStorage.getItem("gauge-communicator-theme");
      document.documentElement.dataset.theme = saved === "dark" ? "dark" : "light";
    } catch {
      document.documentElement.dataset.theme = "light";
    }
  })();
`;

export const metadata = {
  title: "Gauge Communicator",
  description:
    "A local-first Web Serial console for vacuum gauges: SKY CDG, PSG55x, PCG55x, PPG550/570 and more.",
  applicationName: "Gauge Communicator",
  manifest: "./manifest.webmanifest",
  icons: {
    icon: "./icon.svg"
  }
};

export const viewport = {
  colorScheme: "light dark",
  themeColor: "#124477",
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
