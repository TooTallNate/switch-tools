import { ThemeProvider as NextThemesProvider } from "next-themes"
import type { ComponentProps } from "react"

/**
 * Wraps `next-themes` with the defaults this app uses.
 * Class-based dark mode is wired in `index.css` via `@custom-variant dark`.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="nx-archive:theme"
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
