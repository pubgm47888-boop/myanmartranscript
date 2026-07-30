import "./globals.css";

export const metadata = {
  title: "AI Movie Recap Studio",
  description: "Auto-sync AI movie recap generator with Burmese narration and subtitles",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="my">
      <body className="text-gray-100 min-h-screen">{children}</body>
    </html>
  );
}
