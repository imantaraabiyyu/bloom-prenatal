import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

export const metadata = {
  title: "Bloom — Pelacak Gizi Kehamilan",
  description: "Catat menu harian dan vitamin kehamilan, lihat apakah kebutuhan gizi harian sudah tercukupi.",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Bloom" },
};

export const viewport = {
  themeColor: "#251722",
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <head>
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      </head>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
