/**
 * Preview pane for Standard MIDI files (`.mid` / `.midi`).
 *
 * Surfaces:
 *   - parsed metadata (track count, duration, programs, channels)
 *   - an SF2 picker (sibling auto-resolve + file picker fallback)
 *   - play / pause / scrub controls driven by spessasynth_lib
 *
 * Lifecycle:
 *   - On mount, parse the MIDI metadata up front (cheap).
 *   - Lazily look for a sibling `.sf2` file in the surrounding
 *     archive — opens the LGP's parent directory, scans for
 *     entries with that extension, picks the first.
 *   - When the user clicks Play (and a SoundFont is loaded), spin
 *     up an `AudioContext` + `WorkletSynthesizer` + `Sequencer`.
 *     The worklet processor lives at `/spessasynth_processor.min.js`
 *     (copied into `public/` by `scripts/copy-worklets.mjs`).
 *   - On unmount or file change, stop the sequencer and close the
 *     AudioContext.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CircleAlertIcon, MusicIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react"
import type { Sequencer, WorkletSynthesizer } from "spessasynth_lib"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Separator } from "~/components/ui/separator"
import type { Node } from "~/lib/archive"
import {
  parseMidiForView,
  parseSf2ForView,
  type MidiView,
  type Sf2View,
} from "~/lib/preview"
import { formatBytes } from "~/lib/utils"

import { ErrorFiller, LoadingFiller, formatDuration, useAsync } from "./preview-pane"

const WORKLET_URL = "/spessasynth_processor.min.js"

/** Standard MIDI General-MIDI program names (0..127). */
const GM_INSTRUMENTS = [
  "Acoustic Grand Piano", "Bright Acoustic Piano", "Electric Grand Piano", "Honky-tonk Piano",
  "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet",
  "Celesta", "Glockenspiel", "Music Box", "Vibraphone",
  "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
  "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ",
  "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
  "Acoustic Guitar (nylon)", "Acoustic Guitar (steel)", "Electric Guitar (jazz)", "Electric Guitar (clean)",
  "Electric Guitar (muted)", "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics",
  "Acoustic Bass", "Electric Bass (finger)", "Electric Bass (pick)", "Fretless Bass",
  "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
  "Violin", "Viola", "Cello", "Contrabass",
  "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani",
  "String Ensemble 1", "String Ensemble 2", "Synth Strings 1", "Synth Strings 2",
  "Choir Aahs", "Voice Oohs", "Synth Choir", "Orchestra Hit",
  "Trumpet", "Trombone", "Tuba", "Muted Trumpet",
  "French Horn", "Brass Section", "Synth Brass 1", "Synth Brass 2",
  "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax",
  "Oboe", "English Horn", "Bassoon", "Clarinet",
  "Piccolo", "Flute", "Recorder", "Pan Flute",
  "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
  "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)",
  "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass + lead)",
  "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)",
  "Pad 5 (bowed)", "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)",
  "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)",
  "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)",
  "Sitar", "Banjo", "Shamisen", "Koto",
  "Kalimba", "Bagpipe", "Fiddle", "Shanai",
  "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock",
  "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
  "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet",
  "Telephone Ring", "Helicopter", "Applause", "Gunshot",
]

interface SoundFontOption {
  /** Display name. */
  name: string
  /** Source — used to decide how to materialise bytes. */
  source: "sibling" | "file"
  /** Bytes ready to feed `soundBankManager.addSoundBank`. */
  bytes: ArrayBuffer
}

export function MidiPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  // Step 1: parse the MIDI bytes (fast — < 50ms for typical files).
  const { loading, data, error } = useAsync(async () => {
    const blob = await node.blob!()
    return parseMidiForView(blob)
  }, [node.id])

  // Step 2: find sibling .sf2 file(s) in the archive parent dir.
  const { data: siblingSf2s } = useAsync(async () => {
    if (!root) return [] as Array<{ node: Node; name: string }>
    return findSiblingSoundFonts(root, node)
  }, [node.id, root])

  // Step 3: hold the currently-selected SoundFont (sibling or
  // user-picked). Null until the user makes a choice.
  const [soundFont, setSoundFont] = useState<SoundFontOption | null>(null)
  // Auto-select the first sibling if exactly one was found —
  // saves a click for the common FF7 case where `midi.lgp` lives
  // next to a single SF2.
  useEffect(() => {
    if (!siblingSf2s || siblingSf2s.length === 0) return
    if (soundFont !== null) return
    ;(async () => {
      const first = siblingSf2s[0]!
      const blob = await first.node.blob!()
      const bytes = await blob.arrayBuffer()
      setSoundFont({ name: first.name, source: "sibling", bytes })
    })()
  }, [siblingSf2s, soundFont])

  if (loading) return <LoadingFiller label="Parsing MIDI…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div className="flex items-center gap-2">
        <MusicIcon className="size-4" />
        <h2 className="font-heading text-base font-medium">
          {node.name}
        </h2>
      </div>
      <Separator />

      <MidiPlayer view={v} soundFont={soundFont} />

      <SoundFontPicker
        siblingSf2s={siblingSf2s ?? []}
        soundFont={soundFont}
        onPick={setSoundFont}
      />

      <MidiMetadata view={v} />
    </div>
  )
}

/**
 * The synthesizer + sequencer + transport controls. Boots the
 * audio graph lazily — only when the user actually clicks Play.
 */
function MidiPlayer({
  view,
  soundFont,
}: {
  view: MidiView
  soundFont: SoundFontOption | null
}) {
  // Live audio graph state. We hold these in refs (not React state)
  // because they're mutable runtime objects we don't want re-
  // rendered on every tick.
  const ctxRef = useRef<AudioContext | null>(null)
  const synthRef = useRef<WorkletSynthesizer | null>(null)
  const seqRef = useRef<Sequencer | null>(null)

  // UI state that DOES drive renders.
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [bootError, setBootError] = useState<Error | null>(null)
  const [booting, setBooting] = useState(false)

  // Tear down when the MIDI or SF2 changes.
  useEffect(() => {
    return () => {
      try {
        seqRef.current?.pause()
      } catch {
        /* ignore */
      }
      try {
        synthRef.current?.destroy()
      } catch {
        /* ignore */
      }
      try {
        ctxRef.current?.close()
      } catch {
        /* ignore */
      }
      seqRef.current = null
      synthRef.current = null
      ctxRef.current = null
      setReady(false)
      setPlaying(false)
      setCurrentTime(0)
    }
  }, [view, soundFont])

  // Animation-frame loop to update the current-time display while
  // playback is running. We don't poll the sequencer state during
  // pauses to avoid main-thread work for nothing.
  useEffect(() => {
    if (!playing) return
    let rafId = 0
    const tick = () => {
      const seq = seqRef.current
      if (seq) {
        setCurrentTime(seq.currentHighResolutionTime)
        if (seq.paused || seq.isFinished) {
          setPlaying(false)
          return
        }
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [playing])

  const boot = useCallback(async () => {
    if (!soundFont) return
    if (synthRef.current && seqRef.current) return
    setBooting(true)
    setBootError(null)
    try {
      // Lazy-import spessasynth_lib so the ~400 KB worklet bundle
      // only loads when the user actually plays a MIDI file.
      const { WorkletSynthesizer, Sequencer } = await import(
        "spessasynth_lib"
      )
      const ctx = new AudioContext()
      await ctx.audioWorklet.addModule(WORKLET_URL)
      const synth = new WorkletSynthesizer(ctx)
      // SoundBankManager.addSoundBank wants an ArrayBuffer; we
      // already have one from the picker.
      await synth.soundBankManager.addSoundBank(soundFont.bytes, "main")
      await synth.isReady
      // Connect synth output to the speakers (default destination
      // is `ctx.destination`).
      synth.connect(ctx.destination)
      const seq = new Sequencer(synth)
      // spessasynth expects a real ArrayBuffer. `view.bytes` is a
      // Uint8Array view that may not span its entire backing
      // buffer — slice it into a fresh AB so the offsets match.
      const midiBuffer = new ArrayBuffer(view.bytes.byteLength)
      new Uint8Array(midiBuffer).set(view.bytes)
      seq.loadNewSongList([{ binary: midiBuffer, fileName: "song.mid" }])

      ctxRef.current = ctx
      synthRef.current = synth
      seqRef.current = seq
      setReady(true)
    } catch (err) {
      setBootError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setBooting(false)
    }
  }, [view, soundFont])

  const togglePlay = useCallback(async () => {
    // First click: boot the audio graph.
    if (!ready) {
      await boot()
      // After boot, start playback automatically — this is what
      // the user actually pressed Play for.
      const seq = seqRef.current
      const ctx = ctxRef.current
      if (seq && ctx) {
        if (ctx.state === "suspended") await ctx.resume()
        seq.play()
        setPlaying(true)
      }
      return
    }
    const seq = seqRef.current
    const ctx = ctxRef.current
    if (!seq || !ctx) return
    if (ctx.state === "suspended") await ctx.resume()
    if (seq.paused) {
      seq.play()
      setPlaying(true)
    } else {
      seq.pause()
      setPlaying(false)
    }
  }, [ready, boot])

  const stop = useCallback(() => {
    const seq = seqRef.current
    if (!seq) return
    seq.pause()
    seq.currentTime = 0
    setPlaying(false)
    setCurrentTime(0)
  }, [])

  const seek = useCallback((time: number) => {
    const seq = seqRef.current
    if (!seq) return
    seq.currentTime = time
    setCurrentTime(time)
  }, [])

  const duration = view.durationSeconds || 1

  return (
    <section className="flex flex-col gap-2 rounded-md border bg-card p-3">
      {bootError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Audio setup failed</AlertTitle>
          <AlertDescription>{bootError.message}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="default"
          onClick={togglePlay}
          disabled={!soundFont || booting}
          title={
            !soundFont
              ? "Select a SoundFont below to enable playback"
              : booting
                ? "Loading…"
                : playing
                  ? "Pause"
                  : "Play"
          }
        >
          {playing ? (
            <PauseIcon className="size-4" />
          ) : (
            <PlayIcon className="size-4" />
          )}
        </Button>
        <Button
          size="icon"
          variant="outline"
          onClick={stop}
          disabled={!ready || (!playing && currentTime === 0)}
          title="Stop"
        >
          <SquareIcon className="size-4" />
        </Button>
        <input
          type="range"
          min={0}
          max={duration}
          step={duration / 1000}
          value={Math.min(currentTime, duration)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!ready}
          className="flex-1"
        />
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatDuration(currentTime)} / {formatDuration(duration)}
        </span>
      </div>
      {!soundFont && (
        <p className="text-xs text-muted-foreground">
          Pick a SoundFont below to enable playback. MIDI files only describe
          which notes to play; the actual sound comes from the SF2's instrument
          samples.
        </p>
      )}
    </section>
  )
}

/**
 * SoundFont picker — lists any auto-discovered sibling SF2 files
 * + a button to load one from disk.
 */
function SoundFontPicker({
  siblingSf2s,
  soundFont,
  onPick,
}: {
  siblingSf2s: Array<{ node: Node; name: string }>
  soundFont: SoundFontOption | null
  onPick: (sf: SoundFontOption | null) => void
}) {
  const fileInput = useRef<HTMLInputElement | null>(null)
  return (
    <section className="flex flex-col gap-2 rounded-md border bg-card p-3">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        SoundFont
      </h3>
      {siblingSf2s.length > 0 && (
        <select
          className="rounded-md border bg-background px-2 py-1 font-mono text-xs"
          value={soundFont?.source === "sibling" ? soundFont.name : ""}
          onChange={async (e) => {
            const target = siblingSf2s.find((s) => s.name === e.target.value)
            if (!target) return
            const blob = await target.node.blob!()
            const bytes = await blob.arrayBuffer()
            onPick({ name: target.name, source: "sibling", bytes })
          }}
        >
          <option value="" disabled>
            (choose a sibling SF2)
          </option>
          {siblingSf2s.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInput.current?.click()}
        >
          Load SF2 from disk…
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".sf2,.sf3,.dls"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (!file) return
            const bytes = await file.arrayBuffer()
            onPick({ name: file.name, source: "file", bytes })
          }}
        />
        {soundFont && (
          <span className="text-xs text-muted-foreground">
            Using <span className="font-mono">{soundFont.name}</span> (
            {formatBytes(soundFont.bytes.byteLength)})
          </span>
        )}
      </div>
    </section>
  )
}

function MidiMetadata({ view }: { view: MidiView }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border bg-card p-3">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        MIDI
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Format</dt>
        <dd className="font-mono">
          {view.format} (
          {view.format === 0
            ? "single track"
            : view.format === 1
              ? "multi-track simultaneous"
              : "multi-pattern independent"}
          )
        </dd>
        <dt className="text-muted-foreground">Tracks</dt>
        <dd className="font-mono">{view.trackCount}</dd>
        <dt className="text-muted-foreground">Ticks / quarter</dt>
        <dd className="font-mono">{view.ticksPerQuarter}</dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd className="font-mono">{formatDuration(view.durationSeconds)}</dd>
        <dt className="text-muted-foreground">Channels used</dt>
        <dd className="font-mono">
          {view.channelsUsed.length > 0
            ? view.channelsUsed.map((c) => c + 1).join(", ")
            : "—"}
        </dd>
      </dl>
      {view.programs.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Instruments ({view.programs.length})
          </summary>
          <ul className="mt-1 ml-4 list-disc font-mono">
            {view.programs.map((p) => (
              <li key={p}>
                {p}: {GM_INSTRUMENTS[p] ?? "(custom)"}
              </li>
            ))}
          </ul>
        </details>
      )}
      {view.trackNames.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Track names ({view.trackNames.length})
          </summary>
          <ul className="mt-1 ml-4 list-disc">
            {view.trackNames.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/**
 * Walk up from the MIDI file's archive context to find sibling
 * `.sf2` files. For FF7's `midi.lgp` (which contains only MIDI
 * data) the SF2 files live in the same parent directory as the
 * LGP. We scan that directory + 1 level up.
 */
async function findSiblingSoundFonts(
  root: Node,
  selected: Node,
): Promise<Array<{ node: Node; name: string }>> {
  const candidates: Array<{ node: Node; name: string }> = []
  const ids: string[] = []
  let cur = selected.id
  while (cur && cur !== root.id) {
    const slash = cur.lastIndexOf("/")
    if (slash <= 0) break
    cur = cur.slice(0, slash)
    ids.push(cur)
    if (ids.length >= 3) break // limit search depth
  }
  for (const id of ids) {
    const node = await findNodeById(root, id)
    if (!node?.getChildren) continue
    const kids = node._children ?? (node._children = await node.getChildren())
    for (const k of kids) {
      if (k.name.toLowerCase().endsWith(".sf2") && k.blob) {
        candidates.push({ node: k, name: k.name })
      }
    }
    if (candidates.length > 0) break
  }
  return candidates
}

async function findNodeById(
  root: Node,
  target: string,
): Promise<Node | null> {
  if (root.id === target) return root
  if (target !== "" && !target.startsWith(root.id + "/") && root.id !== "") {
    return null
  }
  let cur: Node = root
  while (cur.id !== target) {
    if (!cur.getChildren) return null
    const kids = cur._children ?? (cur._children = await cur.getChildren())
    let next: Node | null = null
    for (const k of kids) {
      if (k.id === target || target.startsWith(k.id + "/")) {
        if (!next || k.id.length > next.id.length) next = k
      }
    }
    if (!next) return null
    cur = next
  }
  return cur
}

// ---------------------------------------------------------------------------
// SF2 preview
// ---------------------------------------------------------------------------

export function Sf2Preview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    const blob = await node.blob!()
    return parseSf2ForView(blob)
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing SoundFont…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return <Sf2InfoPanel view={v} />
}

function Sf2InfoPanel({ view }: { view: Sf2View }) {
  const grouped = useMemo(() => {
    // Group presets by bank for the listing.
    const byBank = new Map<number, typeof view.presets>()
    for (const p of view.presets) {
      const list = byBank.get(p.bank) ?? []
      list.push(p)
      byBank.set(p.bank, list)
    }
    return [...byBank.entries()].sort((a, b) => a[0] - b[0])
  }, [view.presets])
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div className="flex items-center gap-2">
        <MusicIcon className="size-4" />
        <h2 className="font-heading text-base font-medium">
          {view.name || "Unnamed SoundFont"}
        </h2>
      </div>
      <Separator />
      <section className="flex flex-col gap-1 rounded-md border bg-card p-3 text-xs">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Spec version</dt>
          <dd className="font-mono">{view.sfVersion || "—"}</dd>
          <dt className="text-muted-foreground">Engine</dt>
          <dd className="font-mono">{view.engine || "—"}</dd>
          <dt className="text-muted-foreground">Author</dt>
          <dd className="font-mono">{view.author || "—"}</dd>
          <dt className="text-muted-foreground">Copyright</dt>
          <dd className="font-mono">{view.copyright || "—"}</dd>
          <dt className="text-muted-foreground">Presets</dt>
          <dd className="font-mono">{view.presets.length}</dd>
          <dt className="text-muted-foreground">Samples</dt>
          <dd className="font-mono">{view.sampleCount}</dd>
          <dt className="text-muted-foreground">Sample data</dt>
          <dd className="font-mono">{formatBytes(view.sampleDataSize)}</dd>
        </dl>
        {view.comment && (
          <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
            {view.comment}
          </p>
        )}
      </section>
      <section className="flex flex-col gap-2 rounded-md border bg-card p-3 text-xs">
        <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Presets
        </h3>
        <div className="flex flex-col gap-2">
          {grouped.map(([bank, presets]) => (
            <details key={bank} open={bank === 0}>
              <summary className="cursor-pointer text-muted-foreground">
                Bank {bank} ({presets.length})
              </summary>
              <ul className="mt-1 ml-4 list-disc font-mono">
                {presets
                  .slice()
                  .sort((a, b) => a.program - b.program)
                  .map((p) => (
                    <li key={`${p.bank}:${p.program}`}>
                      {String(p.program).padStart(3, "0")} — {p.name || "(unnamed)"}
                    </li>
                  ))}
              </ul>
            </details>
          ))}
        </div>
      </section>
    </div>
  )
}
