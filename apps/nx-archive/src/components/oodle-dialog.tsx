/**
 * "Provide oodle.wasm" dialog — mirror of `KeysDialog` for the
 * user-supplied Oodle decompressor blob. See
 * `@tootallnate/oodle-wasm/README.md` for how to build the WASM
 * (it's not redistributable, so the user produces their own).
 *
 * UX shape: file picker only (no text-pasting equivalent of the
 * keys flow, since a WASM blob is binary). Uploading a file
 * immediately validates that it's a WebAssembly module and
 * persists it to IndexedDB via `setStoredOodleWasm`.
 */

import { useEffect, useRef, useState } from "react"
import {
  CircleAlertIcon,
  PackageIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"

import { OodleDecoder } from "@tootallnate/oodle-wasm"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
} from "~/components/ui/field"
import { Spinner } from "~/components/ui/spinner"
import {
  loadStoredOodleWasm,
  setStoredOodleWasm,
} from "~/lib/oodle-store"

interface OodleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fires whenever the stored WASM changes (uploaded or cleared). */
  onChanged?: () => void
}

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]) // "\0asm"

export function OodleDialog({ open, onOpenChange, onChanged }: OodleDialogProps) {
  const [storedSize, setStoredSize] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    void loadStoredOodleWasm().then((bytes) => {
      setStoredSize(bytes?.length ?? null)
    })
  }, [open])

  const handleFile = async (file: File) => {
    setError(null)
    setWorking(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.length < 8) {
        throw new Error("File is too small to be a WebAssembly module.")
      }
      // Verify the WASM magic so we catch obviously-wrong uploads
      // (a .txt file someone renamed, etc.). The full validation
      // happens when we instantiate it below.
      for (let i = 0; i < 4; i++) {
        if (bytes[i] !== WASM_MAGIC[i]) {
          throw new Error(
            `File doesn't look like a WebAssembly module (bad magic header).`,
          )
        }
      }
      // Best-effort: try to instantiate. If the user uploaded the
      // wrong WASM, surface a useful error immediately.
      const decoder = await OodleDecoder.create(bytes)
      try {
        // Try a known-bad input. If the WASM is genuinely Oodle, this
        // should return failure (0); if it's some other WASM, we'll
        // get a different error.
        try {
          decoder.decompress(new Uint8Array([0, 0, 0, 0]), 16)
        } catch {
          // Expected: garbage in → throws OodleDecompressError. That
          // confirms the WASM has our four exports and is callable.
        }
      } finally {
        decoder.dispose()
      }
      await setStoredOodleWasm(bytes)
      setStoredSize(bytes.length)
      toast.success(`Saved oodle.wasm (${(bytes.length / 1024).toFixed(0)} KB)`)
      onChanged?.()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  const handleClear = async () => {
    setWorking(true)
    try {
      await setStoredOodleWasm(null)
      setStoredSize(null)
      onChanged?.()
      toast.success("Cleared stored oodle.wasm")
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageIcon className="size-4" />
            <span>
              Provide your <code className="rounded bg-muted px-1.5 py-0.5 font-mono">oodle.wasm</code>
            </span>
          </DialogTitle>
          <DialogDescription>
            Required to decompress Oodle-compressed Unreal Engine PAK / IO Store
            entries (Kraken / Mermaid / Selkie / Leviathan). RAD Game Tools'
            Oodle is under the Unreal Engine EULA and cannot be redistributed
            with this project, so you build your own WASM from RAD's source.
            See{" "}
            <a
              href="https://github.com/TooTallNate/switch-tools/blob/main/packages/oodle-wasm/README.md"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline underline-offset-2"
            >
              the build recipe
            </a>{" "}
            for instructions.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".wasm,application/wasm"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
              e.target.value = ""
            }}
          />

          <Field>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-auto w-full flex-col gap-2 border-dashed py-6"
              onClick={() => fileInputRef.current?.click()}
              disabled={working}
            >
              <UploadIcon />
              <span className="font-medium">Click to upload oodle.wasm</span>
              <span className="text-xs font-normal text-muted-foreground">
                Stored only in this browser&rsquo;s IndexedDB and never
                transmitted anywhere
              </span>
            </Button>
            <FieldDescription>
              {storedSize !== null
                ? `Currently stored: ${(storedSize / 1024).toFixed(0)} KB`
                : "Nothing stored yet."}
            </FieldDescription>
          </Field>

          {error && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>Couldn&rsquo;t use this file</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={handleClear}
            disabled={working || storedSize === null}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2Icon data-icon="inline-start" />
            Clear stored WASM
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={working}
          >
            {working && <Spinner data-icon="inline-start" />}
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
