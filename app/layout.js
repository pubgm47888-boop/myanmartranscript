import './globals.css'

export const metadata = {
  title: 'AI Movie Recap Studio',
  description: 'AI Generated Video Recap Tool with Custom Subtitles and Voice-over',
}

export default function RootLayout({ children }) {
  return (
    <html lang="my">
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  )
}
