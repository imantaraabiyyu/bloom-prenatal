import "./globals.css";

export const metadata = {
  title: "Bloom — Pelacak Gizi Kehamilan",
  description: "Catat menu harian dan vitamin kehamilan, lihat apakah kebutuhan gizi harian sudah tercukupi.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
