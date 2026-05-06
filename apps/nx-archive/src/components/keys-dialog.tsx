import { useEffect, useRef, useState } from "react"
import {
  CircleAlertIcon,
  KeyIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"

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
  FieldLabel,
} from "~/components/ui/field"
import { Spinner } from "~/components/ui/spinner"
import { Textarea } from "~/components/ui/textarea"
import {
  deriveKeySet,
  getStoredKeysText,
  setStoredKeysText,
  validateKeysText,
} from "~/lib/keys-store"
import type { KeySet } from "@tootallnate/nca"

interface KeysDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (info: { keySet: KeySet; text: string } | null) => void
}

export function KeysDialog({ open, onOpenChange, onSaved }: KeysDialogProps) {
  const [text, setText] = useState<string>("")
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<{ count: number } | null>(null)
  const [working, setWorking] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const stored = getStoredKeysText()
    if (stored) {
      setText(stored)
      const v = validateKeysText(stored)
      setInfo({ count: v.count })
    } else {
      setText("")
      setInfo(null)
    }
    setError(null)
  }, [open])

  const updateText = (newText: string) => {
    setText(newText)
    if (newText) {
      const v = validateKeysText(newText)
      setInfo({ count: v.count })
      setError(v.valid ? null : `Missing required keys: ${v.missing.join(", ")}`)
    } else {
      setInfo(null)
      setError(null)
    }
  }

  const saveText = async (rawText: string) => {
    setError(null)
    const v = validateKeysText(rawText)
    if (!v.valid) {
      setError(`Missing required keys: ${v.missing.join(", ")}`)
      return false
    }
    try {
      setWorking(true)
      const keySet = await deriveKeySet(rawText)
      setStoredKeysText(rawText)
      onSaved({ keySet, text: rawText })
      toast.success(`Saved ${v.count} keys`)
      onOpenChange(false)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setWorking(false)
    }
  }

  const handleFile = async (file: File) => {
    const t = await file.text()
    updateText(t)
    // Uploading a file is an explicit "I want to use this" action — if it
    // looks valid, save it immediately rather than making the user click
    // Save again. Falls back to manual Save if validation fails.
    const v = validateKeysText(t)
    if (v.valid) await saveText(t)
  }

  const handleSave = () => saveText(text)

  const handleClear = () => {
    setText("")
    setInfo(null)
    setError(null)
    setStoredKeysText(null)
    onSaved(null)
    toast.success("Cleared stored keys")
  }

  const isInvalid = !!error && !!text

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyIcon className="size-4" />
            <span>
              Provide your <code className="rounded bg-muted px-1.5 py-0.5 font-mono">prod.keys</code>
            </span>
          </DialogTitle>
          <DialogDescription>
            Required to decrypt NCA, NSP, XCI, and NCZ archives. Your keys are
            stored only in this browser&rsquo;s <code>localStorage</code> and never
            transmitted anywhere.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".keys,text/plain"
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
            >
              <UploadIcon />
              <span className="font-medium">Click to upload a prod.keys file</span>
              <span className="text-xs font-normal text-muted-foreground">
                Or paste the contents below
              </span>
            </Button>
          </Field>

          <Field data-invalid={isInvalid || undefined}>
            <FieldLabel htmlFor="keys-text">Keys content</FieldLabel>
            <Textarea
              id="keys-text"
              aria-invalid={isInvalid || undefined}
              value={text}
              onChange={(e) => updateText(e.target.value)}
              placeholder={
                "header_key = 00112233445566778899aabbccddeeff...\nkey_area_key_application_00 = 00112233...\n..."
              }
              className="h-44 font-mono text-xs"
            />
            <FieldDescription>
              {info ? (
                <>
                  Detected{" "}
                  <span className="font-medium text-foreground">{info.count}</span>{" "}
                  keys.
                </>
              ) : (
                <>Standard <code>prod.keys</code> format: <code>key = hex_value</code> per line.</>
              )}
            </FieldDescription>
          </Field>

          {error && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>Missing required keys</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={handleClear}
            disabled={working || !text}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2Icon data-icon="inline-start" />
            Clear stored keys
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={working}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={working || !text}>
              {working && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
