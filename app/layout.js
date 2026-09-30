import "./globals.css";

const themeBootScript = `
  (() => {
    try {
      const saved = localStorage.getItem("gauge-communicator-theme");
      const theme = saved === "light" || saved === "dark"
        ? saved
        : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      document.documentElement.dataset.theme = theme;
    } catch {
      document.documentElement.dataset.theme = "dark";
    }
  })();
`;

export const metadata = {
  title: "Gauge Serial Communicator",
  description:
    "A local-first Web Serial console for INFICON vacuum gauges: SKY CDG, PSG55x, PCG55x, PPG550/570 and more.",
  applicationName: "Gauge Serial Communicator",
  manifest: "./manifest.webmanifest",
  icons: {
    icon: "./icon.svg"
  }
};

export const viewport = {
  colorScheme: "dark light",
  themeColor: "#0b1118",
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
