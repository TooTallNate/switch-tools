import { useEffect, useRef } from "react"
import {
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  GithubIcon,
  KeyIcon,
  KeyRoundIcon,
  PackageIcon,
  UploadIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip"
import { ThemeToggle } from "~/components/theme-toggle"
import {
  isDirectoryPickerSupported,
  pickDirectoryViaHandle,
  walkedDirectoryFromFileList,
  type WalkedDirectory,
} from "~/lib/directory"
import {
  isFileSystemAccessApiSupported,
  pickFileWithHandle,
} from "~/lib/last-file-store"
import { formatBytes } from "~/lib/utils"

interface AppHeaderProps {
  onOpenFile: (file: File) => void
  onOpenDirectory: (directory: WalkedDirectory) => void
  onOpenKeys: () => void
  onOpenOodle: () => void
  onCloseFile: () => void
  hasFile: boolean
  hasKeys: boolean
  hasOodle: boolean
  currentFileName?: string
  currentFileSize?: number
  onPickerError: (err: Error) => void
}

export function AppHeader({
  onOpenFile,
  onOpenDirectory,
  onOpenKeys,
  onOpenOodle,
  onCloseFile,
  hasFile,
  hasKeys,
  hasOodle,
  currentFileName,
  currentFileSize,
  onPickerError,
}: AppHeaderProps) {
  const directoryInputRef = useRef<HTMLInputElement>(null)

  /** Resolve the static file `<input>` rendered by `index.html`. */
  const getFileInput = (): HTMLInputElement | null =>
    document.getElementById(
      "nx-archive-file-input",
    ) as HTMLInputElement | null

  // The file `<input>` lives in `index.html` rather than in this
  // component's JSX — see that file for the rationale. We attach
  // a `change` listener here so that *in-session* file picks
  // route through `onOpenFile`. The **boot-time restore** (when
  // the browser auto-fills `.files` from a previous session,
  // BEFORE React mounts) is handled by App.tsx instead, since
  // it needs to wait for `prod.keys` / Oodle / Bink2 to finish
  // loading from IndexedDB before walking into the file —
  // otherwise NCA traversal trips ProdKeysMissingError.
  useEffect(() => {
    const el = document.getElementById(
      "nx-archive-file-input",
    ) as HTMLInputElement | null
    if (!el) return
    const handleChange = () => {
      const f = el.files?.[0]
      if (f) onOpenFile(f)
    }
    el.addEventListener("change", handleChange)
    return () => {
      el.removeEventListener("change", handleChange)
    }
    // `onOpenFile` is stable (parent uses `useCallback`) so the
    // listener captured at mount stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Pick a file via FSA API (Chromium) for next-reload
   * restoration via stored handle, falling back to clicking the
   * static `<input>` (Firefox/Safari — Firefox restores via its
   * built-in form-state mechanism).
   */
  const handlePickFile = async () => {
    if (isFileSystemAccessApiSupported()) {
      try {
        const picked = await pickFileWithHandle()
        if (picked) onOpenFile(picked.file)
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return
        onPickerError(err instanceof Error ? err : new Error(String(err)))
      }
      return
    }
    getFileInput()?.click()
  }

  const handleOpenDirectory = async () => {
    // Prefer the modern API; gracefully fall back to <input webkitdirectory>.
    if (isDirectoryPickerSupported()) {
      try {
        const directory = await pickDirectoryViaHandle()
        onOpenDirectory(directory)
        return
      } catch (err) {
        // The user cancelling raises an AbortError; that's not an error
        // condition to surface.
        if (err instanceof Error && err.name === "AbortError") return
        onPickerError(err instanceof Error ? err : new Error(String(err)))
        return
      }
    }
    directoryInputRef.current?.click()
  }

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 flex-wrap items-center gap-3 border-b bg-card/85 px-3 backdrop-blur supports-backdrop-filter:bg-card/70">
      {/*
        The file `<input>` lives in `index.html` — see that file
        for the rationale (browser form-restoration requires the
        element to exist at DOM-parse time, before React mounts).
        We only render the legacy `webkitdirectory` directory
        picker here since it doesn't need restoration.
      */}
      <input
        ref={directoryInputRef}
        type="file"
        className="hidden"
        // @ts-expect-error — webkitdirectory isn't in the lib.dom types
        webkitdirectory=""
        directory=""
        multiple
        onChange={(e) => {
          const list = e.target.files
          if (list && list.length > 0) {
            onOpenDirectory(walkedDirectoryFromFileList(list))
          }
          e.target.value = ""
        }}
      />

      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
          <JoyConIcon />
        </div>
        <div className="leading-tight">
          <div className="font-heading text-sm font-medium">nx-archive</div>
          <div className="hidden text-[10px] tracking-wider text-muted-foreground uppercase sm:block">
            Switch archive browser
          </div>
        </div>
      </div>

      {hasFile && currentFileName && (
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-muted px-2.5 py-1">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{currentFileName}</div>
            {currentFileSize !== undefined && (
              <div className="truncate text-[10px] text-muted-foreground">
                {formatBytes(currentFileSize)}
              </div>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onCloseFile}
                aria-label="Close file"
              >
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close file</TooltipContent>
          </Tooltip>
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {hasFile && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <UploadIcon data-icon="inline-start" />
                Open
                <ChevronDownIcon data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={handlePickFile}>
                  <FileIcon />
                  Open file…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleOpenDirectory}>
                  <FolderIcon />
                  Open directory…
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={onCloseFile} variant="destructive">
                  <XIcon />
                  Close file
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button variant="outline" size="sm" onClick={onOpenKeys}>
          {hasKeys ? (
            <KeyRoundIcon data-icon="inline-start" className="text-primary" />
          ) : (
            <KeyIcon data-icon="inline-start" />
          )}
          {hasKeys ? "Keys" : "Add keys"}
          {hasKeys && (
            <Badge variant="secondary" className="ml-0.5">
              loaded
            </Badge>
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={onOpenOodle}>
          <PackageIcon
            data-icon="inline-start"
            className={hasOodle ? "text-primary" : undefined}
          />
          Oodle
          {hasOodle && (
            <Badge variant="secondary" className="ml-0.5">
              loaded
            </Badge>
          )}
        </Button>
        <ThemeToggle />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" asChild>
              <a
                href="https://github.com/TooTallNate/switch-tools"
                target="_blank"
                rel="noreferrer"
                aria-label="Source on GitHub"
              >
                <GithubIcon />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Source on GitHub</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}

function JoyConIcon() {
  return (
    <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
      <rect x="2" y="6" width="13" height="20" rx="6" fill="var(--joycon-blue)" />
      <rect x="17" y="6" width="13" height="20" rx="6" fill="var(--joycon-red)" />
      <circle cx="8" cy="11" r="1.6" fill="white" />
      <circle cx="24" cy="21" r="1.6" fill="white" />
    </svg>
  )
}
