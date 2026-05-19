/**
 * Preview for FF7 PC `scene.bin` — the 256-entry archive of
 * enemy / attack / formation / AI-script data used by every
 * encounter in the game. We decompress every gzip blob,
 * decode every scene, and present a searchable list with
 * the most useful per-enemy fields.
 *
 * The full enemy struct has ~30 fields; the preview surfaces
 * the headline stats (HP / MP / EXP / Gil / level) plus
 * filterable drops + attack-list + AI-script summary.
 */
import { useEffect, useMemo, useState } from "react"
import {
	iterateSceneBinBlocks,
	gunzipSceneBytes,
	parseScene,
	type ParsedScene,
	type SceneEnemy,
	SCRIPT_SLOT_NAMES,
} from "@tootallnate/ff7-scene"
import type { Node } from "~/lib/archive"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"

interface ParsedAll {
	scenes: ParsedScene[]
	/** Flat enemy list with sceneIndex annotation for searching. */
	enemyList: { sceneIndex: number; slot: number; enemy: SceneEnemy }[]
}

async function parseAll(blob: Blob): Promise<ParsedAll> {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	const scenes: ParsedScene[] = []
	const enemyList: ParsedAll["enemyList"] = []
	for (const { sceneIndex, compressed } of iterateSceneBinBlocks(bytes)) {
		try {
			const decompressed = await gunzipSceneBytes(compressed)
			const scene = parseScene(decompressed, sceneIndex)
			scenes.push(scene)
			for (let slot = 0; slot < scene.enemies.length; slot++) {
				const enemy = scene.enemies[slot]
				if (enemy) enemyList.push({ sceneIndex, slot, enemy })
			}
		} catch {
			// One scene failing shouldn't kill the rest.
		}
	}
	return { scenes, enemyList }
}

const ELEMENT_NAMES: Record<number, string> = {
	0x00: "Fire",
	0x01: "Ice",
	0x02: "Bolt",
	0x03: "Earth",
	0x04: "Bio",
	0x05: "Gravity",
	0x06: "Water",
	0x07: "Wind",
	0x08: "Holy",
	0x09: "Health",
	0x0a: "Cut",
	0x0b: "Hit",
	0x0c: "Punch",
	0x0d: "Shoot",
	0x0e: "Scream",
	0x0f: "Hidden",
}
const ELEMENT_RATE_NAMES: Record<number, string> = {
	0x00: "Death",
	0x02: "2× damage",
	0x04: "½ damage",
	0x05: "Nullify",
	0x06: "Absorb",
	0x07: "Full heal",
}

function elementsLabel(elements: number[], rates: number[]): string {
	const parts: string[] = []
	for (let i = 0; i < elements.length; i++) {
		if (elements[i] === 0xff) continue
		const el = ELEMENT_NAMES[elements[i]!] ?? `0x${elements[i]!.toString(16)}`
		const rate = ELEMENT_RATE_NAMES[rates[i]!] ?? `0x${rates[i]!.toString(16)}`
		parts.push(`${el}: ${rate}`)
	}
	return parts.length === 0 ? "—" : parts.join(", ")
}

export function Ff7SceneBinPreview({ node }: { node: Node }) {
	const { loading, data, error } = useAsync(
		async () => parseAll(await node.blob!()),
		[node.id],
	)
	const [search, setSearch] = useState("")
	const [selectedScene, setSelectedScene] = useState<number | null>(null)

	const filtered = useMemo(() => {
		if (!data) return []
		const q = search.trim().toLowerCase()
		if (!q) return data.enemyList
		return data.enemyList.filter((e) => e.enemy.name.toLowerCase().includes(q))
	}, [data, search])

	// Auto-select the first enemy on the filter result whenever
	// the search changes.
	useEffect(() => {
		if (filtered.length === 0) {
			setSelectedScene(null)
			return
		}
		setSelectedScene(filtered[0]!.sceneIndex)
	}, [filtered])

	if (loading) return <LoadingFiller label="Decompressing 256 scenes…" />
	if (error) return <ErrorFiller error={error} />
	if (!data) return null

	const selScene = selectedScene !== null
		? data.scenes.find((s) => s.sceneIndex === selectedScene) ?? null
		: null

	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-4 py-2">
				<h2 className="font-heading text-sm font-medium">{node.name}</h2>
				<p className="text-xs text-muted-foreground">
					FF7 battle scene archive · {data.scenes.length} scenes ·{" "}
					{data.enemyList.length} enemies
				</p>
				<input
					type="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Filter enemies (e.g. Sephiroth, Tonberry, Ruby Weapon)…"
					className="mt-2 w-full rounded border bg-background px-2 py-1 text-sm"
				/>
			</div>
			<div className="flex flex-1 overflow-hidden">
				<div className="w-1/2 overflow-auto border-r">
					<table className="w-full text-xs">
						<thead className="sticky top-0 bg-background border-b">
							<tr className="text-left">
								<th className="px-2 py-1 w-12">#</th>
								<th className="px-2 py-1">Name</th>
								<th className="px-2 py-1 w-12 text-right">Lvl</th>
								<th className="px-2 py-1 w-20 text-right">HP</th>
								<th className="px-2 py-1 w-16 text-right">MP</th>
								<th className="px-2 py-1 w-20 text-right">EXP</th>
								<th className="px-2 py-1 w-16 text-right">Gil</th>
							</tr>
						</thead>
						<tbody>
							{filtered.map((entry) => (
								<tr
									key={`${entry.sceneIndex}-${entry.slot}`}
									className={`cursor-pointer hover:bg-accent ${
										selectedScene === entry.sceneIndex ? "bg-accent" : ""
									}`}
									onClick={() => setSelectedScene(entry.sceneIndex)}
								>
									<td className="px-2 py-1 text-muted-foreground">
										{entry.sceneIndex}
									</td>
									<td className="px-2 py-1 font-medium">{entry.enemy.name}</td>
									<td className="px-2 py-1 text-right">{entry.enemy.level}</td>
									<td className="px-2 py-1 text-right tabular-nums">
										{entry.enemy.hp.toLocaleString()}
									</td>
									<td className="px-2 py-1 text-right tabular-nums">
										{entry.enemy.mp.toLocaleString()}
									</td>
									<td className="px-2 py-1 text-right tabular-nums">
										{entry.enemy.exp.toLocaleString()}
									</td>
									<td className="px-2 py-1 text-right tabular-nums">
										{entry.enemy.gil.toLocaleString()}
									</td>
								</tr>
							))}
							{filtered.length === 0 && (
								<tr>
									<td
										colSpan={7}
										className="px-2 py-4 text-center text-muted-foreground"
									>
										No enemies match "{search}".
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
				<div className="w-1/2 overflow-auto p-4 text-xs">
					{selScene ? (
						<ScenePanel scene={selScene} />
					) : (
						<p className="text-muted-foreground">
							Select an enemy to see its scene details.
						</p>
					)}
				</div>
			</div>
		</div>
	)
}

function ScenePanel({ scene }: { scene: ParsedScene }) {
	const enemies = scene.enemies.filter(Boolean) as SceneEnemy[]
	return (
		<div className="space-y-4">
			<h3 className="font-heading text-sm font-medium">
				Scene #{scene.sceneIndex}
			</h3>
			{enemies.map((enemy, i) => (
				<EnemyPanel key={i} enemy={enemy} />
			))}
			{scene.attacks.length > 0 && (
				<section>
					<h4 className="mb-1 font-medium">Attacks ({scene.attacks.length})</h4>
					<table className="w-full">
						<thead>
							<tr className="border-b text-left text-muted-foreground">
								<th className="px-1 py-0.5">ID</th>
								<th className="px-1 py-0.5">Name</th>
								<th className="px-1 py-0.5 text-right">MP</th>
								<th className="px-1 py-0.5 text-right">Power</th>
								<th className="px-1 py-0.5 text-right">Acc</th>
							</tr>
						</thead>
						<tbody>
							{scene.attacks.map((a) => (
								<tr key={a.id}>
									<td className="px-1 py-0.5 text-muted-foreground">
										{a.id.toString(16).padStart(4, "0")}
									</td>
									<td className="px-1 py-0.5">{a.name}</td>
									<td className="px-1 py-0.5 text-right tabular-nums">
										{a.mpCost}
									</td>
									<td className="px-1 py-0.5 text-right tabular-nums">
										{a.strength}
									</td>
									<td className="px-1 py-0.5 text-right tabular-nums">
										{a.accuracy}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			)}
			<section>
				<h4 className="mb-1 font-medium">AI scripts</h4>
				{scene.enemyAI.entities.map((ent, i) => {
					if (!ent) return null
					const populated = ent.scripts
						.map((s, idx) => ({ s, idx }))
						.filter((x) => x.s !== null)
					if (populated.length === 0) return null
					return (
						<div key={i} className="mb-2">
							<div className="text-muted-foreground">
								Enemy {i}: {populated.length} script
								{populated.length === 1 ? "" : "s"}
							</div>
							<ul className="ml-3 list-disc">
								{populated.map(({ s, idx }) => (
									<li key={idx}>
										{SCRIPT_SLOT_NAMES[idx]} ({s!.bytecode.length} byte
										{s!.bytecode.length === 1 ? "" : "s"})
									</li>
								))}
							</ul>
						</div>
					)
				})}
			</section>
		</div>
	)
}

function EnemyPanel({ enemy }: { enemy: SceneEnemy }) {
	return (
		<section className="rounded border p-3">
			<h4 className="font-heading mb-2 font-medium">{enemy.name}</h4>
			<dl className="grid grid-cols-2 gap-x-3 gap-y-1">
				<dt className="text-muted-foreground">Level</dt>
				<dd className="tabular-nums">{enemy.level}</dd>
				<dt className="text-muted-foreground">HP</dt>
				<dd className="tabular-nums">{enemy.hp.toLocaleString()}</dd>
				<dt className="text-muted-foreground">MP</dt>
				<dd className="tabular-nums">{enemy.mp.toLocaleString()}</dd>
				<dt className="text-muted-foreground">EXP / AP / Gil</dt>
				<dd className="tabular-nums">
					{enemy.exp.toLocaleString()} / {enemy.ap.toLocaleString()} /{" "}
					{enemy.gil.toLocaleString()}
				</dd>
				<dt className="text-muted-foreground">Str / Mag / Def / MDef</dt>
				<dd className="tabular-nums">
					{enemy.strength} / {enemy.magic} / {enemy.defense} / {enemy.magicDef}
				</dd>
				<dt className="text-muted-foreground">Spd / Lck / Eva</dt>
				<dd className="tabular-nums">
					{enemy.speed} / {enemy.luck} / {enemy.evade}
				</dd>
				<dt className="text-muted-foreground">Back attack ×</dt>
				<dd className="tabular-nums">{enemy.backAttackMul}/8</dd>
				<dt className="text-muted-foreground">Elements</dt>
				<dd className="col-start-2">
					{elementsLabel(enemy.elements, enemy.elementRates)}
				</dd>
				<dt className="text-muted-foreground">Status immunities</dt>
				<dd className="tabular-nums">
					0x{enemy.statusImmunities.toString(16).padStart(8, "0")}
				</dd>
				{enemy.morphItem !== null && (
					<>
						<dt className="text-muted-foreground">Morph item ID</dt>
						<dd className="tabular-nums">
							0x{enemy.morphItem.toString(16).padStart(4, "0")}
						</dd>
					</>
				)}
			</dl>
			{enemy.drops.some(Boolean) && (
				<div className="mt-2">
					<div className="text-muted-foreground">Drops / Steals</div>
					<ul className="ml-3 list-disc">
						{enemy.drops.map((d, i) =>
							d ? (
								<li key={i}>
									{d.kind}: item 0x
									{d.itemID.toString(16).padStart(4, "0")} @{" "}
									{((d.rate / 63) * 100).toFixed(1)}%
								</li>
							) : null,
						)}
					</ul>
				</div>
			)}
		</section>
	)
}
