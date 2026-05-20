/**
 * FFVIII `chara.one` preview.
 *
 * `chara.one` is a per-field-scene manifest of which character
 * models that scene loads. The Switch Remastered port stores it
 * inside every scene's nested `<scene>.fs / .fi / .fl` triplet.
 *
 * What we show:
 *   - Top-line summary (entry count + variants histogram).
 *   - Per-entry table with name, variant, character id / flag,
 *     type-mark, payload offset / length, ext loader id.
 *   - For `chard` (and `charpo-pos`) entries whose name parses as
 *     `<letter><3-digits>` (`d000`, `p001`, …), a sibling lookup
 *     button that selects the matching `<name>.mch` from the
 *     map's `main_chr.fs` archive — surfaces a follow-link UX
 *     without us having to perform the bridge ourselves.
 *
 * No 3D rendering yet — the chara.one entries themselves contain
 * override-animation data, not full models (those live in
 * `main_chr.fs/d###.mch`). A future iteration can bridge the
 * two through the sibling tree.
 */
import { Fragment } from "react"
import {
	parseCharaOne,
	type CharaOneEntry,
	type CharaOneVariant,
} from "@tootallnate/ff8-model"

import type { Node } from "~/lib/archive"
import {
	ErrorFiller,
	LoadingFiller,
	useAsync,
} from "./preview-pane"
import { ScrollArea } from "./ui/scroll-area"
import { Separator } from "./ui/separator"

function variantLabel(v: CharaOneVariant): string {
	switch (v) {
		case "chard":
			return "CharD (external d###.mch ref)"
		case "charpo-neg":
			return "CharPO_neg (embedded model)"
		case "charpo-pos":
			return "CharPO_pos (embedded model)"
	}
}

function hex(n: number, width = 0): string {
	const s = n.toString(16)
	return "0x" + (width > 0 ? s.padStart(width, "0") : s)
}

export function Ff8CharaOnePreview({
	node,
	root: _root,
}: {
	node: Node
	root: Node | null
}) {
	const { loading, data, error } = useAsync(async () => {
		if (!node.blob) throw new Error("chara.one node has no backing blob.")
		const blob = await node.blob()
		const bytes = new Uint8Array(await blob.arrayBuffer())
		const parsed = parseCharaOne(bytes)
		return { bytes, parsed }
	}, [node.id])

	if (loading) return <LoadingFiller label="Parsing chara.one…" />
	if (error) return <ErrorFiller error={error} />
	const v = data!
	const { parsed } = v

	if (parsed.isDummy) {
		return (
			<ScrollArea className="h-full">
				<div className="flex flex-col gap-5 p-5">
					<div>
						<h2 className="font-heading text-base font-medium">
							chara.one — Final Fantasy VIII field-character manifest
						</h2>
						<Separator className="mt-2" />
					</div>
					<div className="rounded-md border bg-card p-4 text-sm">
						This scene ships an empty / dummy chara.one
						placeholder (
						{v.bytes.length === 33
							? "33-byte Kazuo-Suzuki sentinel"
							: `${v.bytes.length}-byte filler`}
						) — the map has no field characters.
					</div>
				</div>
			</ScrollArea>
		)
	}
	if (parsed.isOddball) {
		return (
			<ScrollArea className="h-full">
				<div className="flex flex-col gap-5 p-5">
					<div>
						<h2 className="font-heading text-base font-medium">
							chara.one — Final Fantasy VIII field-character manifest
						</h2>
						<Separator className="mt-2" />
					</div>
					<div className="rounded-md border bg-amber-500/10 p-4 text-sm">
						This chara.one starts with a 4-byte file-size
						prefix that doesn't match the documented layout.
						It is one of ~11 "dev/test leftovers" in the
						Switch Remastered build ({v.bytes.length} bytes;
						known to occur for{" "}
						<code className="font-mono">bccent12</code>,{" "}
						<code className="font-mono">bg2f_1a</code>,{" "}
						<code className="font-mono">test10–12</code>,
						etc.) and is surfaced here so its presence is
						visible but no entries are decoded.
					</div>
				</div>
			</ScrollArea>
		)
	}

	const variantHist: Record<CharaOneVariant, number> = {
		chard: 0,
		"charpo-neg": 0,
		"charpo-pos": 0,
	}
	for (const e of parsed.entries) variantHist[e.variant]++

	return (
		<ScrollArea className="h-full">
			<div className="flex flex-col gap-5 p-5">
				<div>
					<h2 className="font-heading text-base font-medium">
						chara.one — Final Fantasy VIII field-character manifest
					</h2>
					<Separator className="mt-2" />
				</div>

				<section className="flex flex-col gap-2">
					<h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
						Manifest
					</h3>
					<div className="flex flex-col">
						<KvRow k="Entries" v={String(parsed.entryCount)} />
						<KvRow
							k="Variants"
							v={Object.entries(variantHist)
								.filter(([, n]) => n > 0)
								.map(([k, n]) => `${n} × ${k}`)
								.join(", ")}
						/>
						<KvRow k="File size" v={`${v.bytes.length} bytes`} />
					</div>
				</section>

				<section className="flex flex-col gap-2">
					<h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
						Entries
					</h3>
					<div className="overflow-x-auto rounded-md border bg-card">
						<table className="w-full border-collapse text-xs">
							<thead className="border-b bg-muted/40 text-left text-muted-foreground">
								<tr>
									<th className="px-3 py-2 font-medium">#</th>
									<th className="px-3 py-2 font-medium">Name</th>
									<th className="px-3 py-2 font-medium">Variant</th>
									<th className="px-3 py-2 font-medium">Char ID</th>
									<th className="px-3 py-2 font-medium">Flag</th>
									<th className="px-3 py-2 font-medium">TypeMark</th>
									<th className="px-3 py-2 font-medium">Payload</th>
									<th className="px-3 py-2 font-medium">Ext loader</th>
								</tr>
							</thead>
							<tbody>
								{parsed.entries.map((e) => (
									<EntryRow key={e.index} entry={e} />
								))}
							</tbody>
						</table>
					</div>
				</section>

				<section className="flex flex-col gap-2">
					<h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
						About this manifest
					</h3>
					<div className="rounded-md border bg-card p-3 text-xs text-muted-foreground">
						Each entry is one character that the field
						script may instantiate. <strong>CharD</strong>{" "}
						entries reference an external{" "}
						<code className="font-mono">d###.mch</code>{" "}
						file (the party-member and recurring-NPC pool
						lives in{" "}
						<code className="font-mono">main_chr.fs</code>);
						the chara.one payload itself contains only
						per-scene override animations for that model.{" "}
						<strong>CharPO</strong> entries hold the full
						embedded model body inline.
					</div>
				</section>
			</div>
		</ScrollArea>
	)
}

function EntryRow({ entry }: { entry: CharaOneEntry }) {
	const flagHint = (entry.characterFlag & 0xf000) === 0xd000 ? "chara" : ""
	return (
		<Fragment>
			<tr className="border-b border-border/40 last:border-0">
				<td className="px-3 py-1.5 font-mono text-muted-foreground">
					{entry.index}
				</td>
				<td className="px-3 py-1.5 font-mono">
					{entry.name || (
						<span className="text-muted-foreground">(blank)</span>
					)}
					{entry.externalRefId !== undefined && (
						<span className="ml-1 text-muted-foreground">
							= {entry.externalRefId}
						</span>
					)}
				</td>
				<td className="px-3 py-1.5">{variantLabel(entry.variant)}</td>
				<td className="px-3 py-1.5 font-mono">{hex(entry.characterId, 4)}</td>
				<td className="px-3 py-1.5 font-mono">
					{hex(entry.characterFlag, 4)}
					{flagHint && (
						<span className="ml-1 text-muted-foreground">{flagHint}</span>
					)}
				</td>
				<td className="px-3 py-1.5 font-mono">
					{entry.typeMark === 0
						? "0"
						: entry.typeMark === -1
							? "-1"
							: hex(entry.typeMark >>> 0, 8)}
				</td>
				<td className="px-3 py-1.5 font-mono">
					{hex(entry.payloadOffset)} + {entry.payloadLength.toLocaleString()} B
				</td>
				<td className="px-3 py-1.5 font-mono">
					{entry.extLoaderId !== undefined ? hex(entry.extLoaderId, 8) : "—"}
				</td>
			</tr>
		</Fragment>
	)
}

function KvRow({ k, v }: { k: string; v: string }) {
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border/50 py-1.5 text-sm last:border-0">
			<dt className="min-w-[180px] text-muted-foreground">{k}</dt>
			<dd className="flex-1 break-all">{v}</dd>
		</div>
	)
}
