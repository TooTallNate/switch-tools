import { useEffect, useRef, useState } from "react"
import {
  ChevronDownIcon,
  FileIcon,
  FileUpIcon,
  FolderArchiveIcon,
  FolderIcon,
} from "lucide-react"
import { Button } from "~/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import { Badge } from "~/components/ui/badge"
import {
  dataTransferContainsDirectory,
  isDirectoryPickerSupported,
  pickDirectoryViaHandle,
  walkedDirectoryFromDataTransfer,
  walkedDirectoryFromFileList,
  type WalkedDirectory,
} from "~/lib/directory"
import {
  isFileSystemAccessApiSupported,
  pickFileWithHandle,
} from "~/lib/last-file-store"
import { cn } from "~/lib/utils"

const SUPPORTED_FORMATS = [
  "nro",
  "nsp",
  "nca",
  "xci",
  "ncz",
  "pfs0",
  "hfs0",
  "romfs",
] as const

interface DropzoneProps {
  onFile: (file: File) => void
  onDirectory: (directory: WalkedDirectory) => void
  onPickerError: (err: Error) => void
}

/**
 * The big, friendly initial picker shown when no file has been opened
 * yet. Supports both individual files and whole directories, picked via
 * dropdown or drag-and-drop. Directory drops use the `webkitGetAsEntry`
 * API to recursively walk; directory clicks prefer the modern File
 * System Access picker, falling back to `<input webkitdirectory>`.
 */
export function Dropzone({ onFile, onDirectory, onPickerError }: DropzoneProps) {
  const directoryInputRef = useRef<HTMLInputElement>(null)
  const [hover, setHover] = useState(false)

  // Resolve the static file `<input>` rendered by `index.html`
  // (see that file for the rationale — browser form-restoration
  // requires the element to exist before React mounts).
  const getFileInput = (): HTMLInputElement | null =>
    document.getElementById(
      "nx-archive-file-input",
    ) as HTMLInputElement | null

  /**
   * Pick a file. On Chromium browsers we use the File System
   * Access API, which gives us a `FileSystemFileHandle` we can
   * persist in IndexedDB for next-reload restoration. On
   * Firefox/Safari we fall back to the static `<input>` click;
   * Firefox additionally restores that input's value across
   * hard reloads (see `index.html` for the form-restoration
   * trick).
   */
  const handlePickFile = async () => {
    if (isFileSystemAccessApiSupported()) {
      try {
        const picked = await pickFileWithHandle()
        if (picked) onFile(picked.file)
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return
        onPickerError(err instanceof Error ? err : new Error(String(err)))
      }
      return
    }
    getFileInput()?.click()
  }

  const handlePickDirectory = async () => {
    if (isDirectoryPickerSupported()) {
      try {
        const directory = await pickDirectoryViaHandle()
        onDirectory(directory)
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return
        onPickerError(err instanceof Error ? err : new Error(String(err)))
      }
      return
    }
    directoryInputRef.current?.click()
  }

  return (
    // Fill `<main>` (a row flexbox) on both axes, then center the card.
    // The card itself overrides `Empty`'s baked-in `flex-1` with
    // `flex-initial` so it doesn't grow to its `max-w-2xl` cap — that
    // way it stays at the natural content width set by `EmptyHeader`/
    // `EmptyContent`'s `max-w-sm`, matching the original look.
    <div className="flex h-full w-full items-center justify-center p-8">
      {/*
        File-picker `<input>` lives in `index.html` (NOT here) so
        the browser restores its value on reload. We only render
        the legacy `webkitdirectory` directory picker locally
        since it doesn't need restoration.
      */}
      <input
        ref={directoryInputRef}
        type="file"
        className="hidden"
        // @ts-expect-error — webkitdirectory isn't in lib.dom types
        webkitdirectory=""
        directory=""
        multiple
        onChange={(e) => {
          const list = e.target.files
          if (list && list.length > 0) {
            onDirectory(walkedDirectoryFromFileList(list))
          }
          e.target.value = ""
        }}
      />
      <Empty
        className={cn(
          // `flex-initial` (= `flex: 0 1 auto`) overrides Empty's
          // `flex-1` so the card doesn't try to grow to fill the
          // main-axis space, and `w-auto` overrides Empty's `w-full`
          // so the card sizes to its content (matching the original
          // shrink-to-fit width of ~28rem driven by the inner header
          // and content blocks' `max-w-sm`). Both overrides are
          // required: without `w-auto` the explicit `width: 100%`
          // on Empty wins regardless of `flex-initial`.
          "max-w-2xl w-auto flex-initial border-2 bg-card transition-all",
          hover && "scale-[1.01] border-primary ring-3 ring-ring/40",
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setHover(true)
        }}
        onDragLeave={() => setHover(false)}
        onDrop={async (e) => {
          e.preventDefault()
          setHover(false)
          const dt = e.dataTransfer
          if (!dt) return
          // If the drop contains any directory entries, walk them all.
          if (dt.items && dataTransferContainsDirectory(dt.items)) {
            try {
              const directory = await walkedDirectoryFromDataTransfer(dt.items)
              if (directory.files.length > 0) onDirectory(directory)
              return
            } catch (err) {
              onPickerError(err instanceof Error ? err : new Error(String(err)))
              return
            }
          }
          const f = dt.files?.[0]
          if (f) onFile(f)
        }}
      >
        <EmptyHeader>
          <EmptyMedia variant="icon" className="size-12 [&_svg:not([class*='size-'])]:size-6">
            <FolderArchiveIcon />
          </EmptyMedia>
          <EmptyTitle className="text-lg">
            Drop a Switch archive (or directory) to begin
          </EmptyTitle>
          <EmptyDescription>
            Browse the contents of any Nintendo Switch archive — extract files,
            preview images and metadata, peek inside encrypted containers.
            Open a single file or a whole directory of loose NCAs / tickets;
            everything runs locally in your browser.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <FileUpIcon data-icon="inline-start" />
                Choose…
                <ChevronDownIcon data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={handlePickFile}>
                  <FileIcon />
                  Open file…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handlePickDirectory}>
                  <FolderIcon />
                  Open directory…
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
            {SUPPORTED_FORMATS.map((f) => (
              <Badge key={f} variant="secondary" className="font-mono uppercase">
                .{f}
              </Badge>
            ))}
          </div>
        </EmptyContent>
      </Empty>
    </div>
  )
}

interface GlobalDragOverlayProps {
  onFile: (file: File) => void
  onDirectory: (directory: WalkedDirectory) => void
  onPickerError: (err: Error) => void
}

/**
 * Full-window drag overlay that appears whenever the user drags a file
 * (or directory) over the page from outside.
 */
export function GlobalDragOverlay({
  onFile,
  onDirectory,
  onPickerError,
}: GlobalDragOverlayProps) {
  const [active, setActive] = useState(false)
  const counter = useRef(0)

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer) return
      if (!Array.from(e.dataTransfer.types ?? []).includes("Files")) return
      counter.current += 1
      setActive(true)
    }
    const onDragLeave = () => {
      counter.current -= 1
      if (counter.current <= 0) {
        counter.current = 0
        setActive(false)
      }
    }
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return
      if (Array.from(e.dataTransfer.types ?? []).includes("Files")) {
        e.preventDefault()
      }
    }
    const onDrop = async (e: DragEvent) => {
      counter.current = 0
      setActive(false)
      const dt = e.dataTransfer
      if (!dt) return
      e.preventDefault()
      if (dt.items && dataTransferContainsDirectory(dt.items)) {
        try {
          const directory = await walkedDirectoryFromDataTransfer(dt.items)
          if (directory.files.length > 0) onDirectory(directory)
        } catch (err) {
          onPickerError(err instanceof Error ? err : new Error(String(err)))
        }
        return
      }
      const file = dt.files?.[0]
      if (file) onFile(file)
    }
    window.addEventListener("dragenter", onDragEnter)
    window.addEventListener("dragleave", onDragLeave)
    window.addEventListener("dragover", onDragOver)
    window.addEventListener("drop", onDrop)
    return () => {
      window.removeEventListener("dragenter", onDragEnter)
      window.removeEventListener("dragleave", onDragLeave)
      window.removeEventListener("dragover", onDragOver)
      window.removeEventListener("drop", onDrop)
    }
  }, [onFile, onDirectory, onPickerError])

  if (!active) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/15 backdrop-blur-sm">
      <div className="rounded-2xl border-2 border-dashed border-primary bg-popover px-8 py-6 text-center shadow-2xl ring-1 ring-foreground/10">
        <FolderArchiveIcon className="mx-auto mb-2 size-10 text-primary" />
        <div className="font-heading text-base font-medium">Drop to open</div>
        <div className="text-xs text-muted-foreground">
          Release to load this file or directory
        </div>
      </div>
    </div>
  )
}
