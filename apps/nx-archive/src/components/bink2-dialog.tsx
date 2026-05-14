/**
 * "Provide bink2.wasm" dialog — mirror of `OodleDialog` for the
 * user-supplied Bink 2 video decoder blob. See
 * `@tootallnate/bink2-wasm/README.md` for how to build the WASM
 * (the upstream decoder is GPL-3.0 and we can't redistribute the
 * compiled artifact alongside this MIT project).
 *
 * Validation: we sniff the WASM magic and then check that the
 * compiled module has the small set of exports the runtime expects
 * (`bink2_open`, `bink2_decode_frame`, …). We don't actually feed
 * it a fixture — Bink2 doesn't have a "decode-this-known-bytes"
 * round-trip the way Oodle does, and instantiating the module just
 * to verify it loads is good enough.
 */

import { useEffect, useRef, useState } from 'react'
import {
	CircleAlertIcon,
	FilmIcon,
	Trash2Icon,
	UploadIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '~/components/ui/dialog'
import { Field, FieldDescription, FieldGroup } from '~/components/ui/field'
import { Spinner } from '~/components/ui/spinner'
import {
	loadStoredBink2Wasm,
	setStoredBink2Wasm,
} from '~/lib/bink2-store'

interface Bink2DialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Fires whenever the stored WASM changes (uploaded or cleared). */
	onChanged?: () => void
}

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]) // "\0asm"

// Minimal set of exports the runtime calls. If any of these is missing
// the upload is rejected — most likely the user picked the wrong file
// (oodle.wasm, some other WASM, etc.).
const REQUIRED_EXPORTS = [
	'memory',
	'bink2_open',
	'bink2_close',
	'bink2_decode_frame',
	'bink2_width',
	'bink2_height',
	'bink2_frame_count',
] as const

export function Bink2Dialog({ open, onOpenChange, onChanged }: Bink2DialogProps) {
	const [storedSize, setStoredSize] = useState<number | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [working, setWorking] = useState(false)
	const fileInputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (!open) return
		setError(null)
		void loadStoredBink2Wasm().then((bytes) => {
			setStoredSize(bytes?.length ?? null)
		})
	}, [open])

	const handleFile = async (file: File) => {
		setError(null)
		setWorking(true)
		try {
			const bytes = new Uint8Array(await file.arrayBuffer())
			if (bytes.length < 8) {
				throw new Error('File is too small to be a WebAssembly module.')
			}
			for (let i = 0; i < 4; i++) {
				if (bytes[i] !== WASM_MAGIC[i]) {
					throw new Error(
						`File doesn't look like a WebAssembly module (bad magic header).`,
					)
				}
			}
			// Compile-only check: we don't need to instantiate (which
			// would require building the WASI stub table and ~6 MB of
			// memory). Just confirm the module compiles and exports
			// what we expect.
			const module = await WebAssembly.compile(bytes)
			const exportNames = new Set(
				WebAssembly.Module.exports(module).map((e) => e.name),
			)
			const missing = REQUIRED_EXPORTS.filter((n) => !exportNames.has(n))
			if (missing.length > 0) {
				throw new Error(
					`This WASM is missing ${missing.length} required export${missing.length === 1 ? '' : 's'} (${missing.join(', ')}). Did you upload the wrong file?`,
				)
			}
			await setStoredBink2Wasm(bytes)
			setStoredSize(bytes.length)
			toast.success(`Saved bink2.wasm (${(bytes.length / 1024).toFixed(0)} KB)`)
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
			await setStoredBink2Wasm(null)
			setStoredSize(null)
			onChanged?.()
			toast.success('Cleared stored bink2.wasm')
		} finally {
			setWorking(false)
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<FilmIcon className="size-4" />
						<span>
							Provide your <code className="rounded bg-muted px-1.5 py-0.5 font-mono">bink2.wasm</code>
						</span>
					</DialogTitle>
					<DialogDescription>
						Required to preview <code>.bk2</code> video files. The Bink 2
						decoder source (
						<a
							href="https://github.com/bbit-git/cnc-ra-libs"
							target="_blank"
							rel="noopener noreferrer"
							className="font-medium text-foreground underline underline-offset-2"
						>
							bbit-git/cnc-ra-libs
						</a>
						) is GPL-3.0, so we can't ship the compiled WASM with this
						MIT-licensed app. See{' '}
						<a
							href="https://github.com/TooTallNate/switch-tools/blob/main/packages/bink2-wasm/README.md"
							target="_blank"
							rel="noopener noreferrer"
							className="font-medium text-foreground underline underline-offset-2"
						>
							the build recipe
						</a>{' '}
						for instructions (≈2 minutes from a fresh clone).
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
							e.target.value = ''
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
							<span className="font-medium">Click to upload bink2.wasm</span>
							<span className="text-xs font-normal text-muted-foreground">
								Stored only in this browser&rsquo;s IndexedDB and never
								transmitted anywhere
							</span>
						</Button>
						<FieldDescription>
							{storedSize !== null
								? `Currently stored: ${(storedSize / 1024).toFixed(0)} KB`
								: 'Nothing stored yet.'}
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
