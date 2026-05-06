/**
 * Filename-fuzzy search box that sits above the file tree.
 *
 * UX:
 *   • Type to filter. Matches stream in as the tree walker visits
 *     them — first results appear in milliseconds even on
 *     multi-GB archives.
 *   • Clear button (×) on the right when there's text.
 *   • Spinner + "Searching N/M…" while the walk is running.
 *   • A "Deep" toggle that includes NCAs / NCZs in the walk;
 *     defaults off so initial searches stay fast.
 *
 * The component owns the walk lifecycle: starting a new query
 * aborts any in-flight walk and starts a fresh one. Results bubble
 * up to the parent via `onResultsChange` so the parent can drive
 * the tree's filter / forced-expand state.
 */

import { useEffect, useRef, useState } from 'react';
import {
	LayersIcon,
	SearchIcon,
	XIcon,
} from 'lucide-react';
import { Button } from '~/components/ui/button';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from '~/components/ui/input-group';
import { Spinner } from '~/components/ui/spinner';
import { cn } from '~/lib/utils';
import type { Node } from '~/lib/archive';
import {
	fuzzyMatch,
	walkTree,
	type MatchResult,
	type WalkedNode,
} from '~/lib/search';

/**
 * One match in the result set, including everything the tree
 * needs to render highlight + decide what to keep visible.
 */
export interface SearchMatch {
	node: Node;
	pathIds: string[];
	pathNames: string[];
	score: number;
	indexes: number[];
}

/** Snapshot of search state communicated to the parent. */
export interface SearchState {
	query: string;
	matches: SearchMatch[];
	/** True while a walk is in progress. */
	walking: boolean;
	/** Containers visited so far. */
	visited: number;
	/** Containers known so far (grows as we expand). */
	totalKnown: number;
}

interface FileTreeSearchProps {
	root: Node;
	onChange: (state: SearchState) => void;
	/**
	 * Forces a fresh walk by changing identity. The parent should
	 * bump this when the user reloads keys or otherwise mutates the
	 * tree's expansion cache.
	 */
	walkVersion?: number;
}

const DEBOUNCE_MS = 120;
/** Throttle UI updates so we don't re-render thousands of times during a walk. */
const RESULT_FLUSH_MS = 60;
/** Cap result count to keep the tree filter affordable. */
const MAX_RESULTS = 500;

export function FileTreeSearch({
	root,
	onChange,
	walkVersion = 0,
}: FileTreeSearchProps) {
	const [query, setQuery] = useState('');
	const [deep, setDeep] = useState(false);
	const [walking, setWalking] = useState(false);
	const [visited, setVisited] = useState(0);
	const [totalKnown, setTotalKnown] = useState(0);

	// We funnel the live state up through `onChange`; keep the
	// callback in a ref so a parent re-binding it doesn't re-trigger
	// the walk.
	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	});

	useEffect(() => {
		// Empty query → clear immediately, no walk needed.
		if (query.trim().length === 0) {
			setWalking(false);
			setVisited(0);
			setTotalKnown(0);
			onChangeRef.current({
				query: '',
				matches: [],
				walking: false,
				visited: 0,
				totalKnown: 0,
			});
			return;
		}

		const debounceHandle = window.setTimeout(() => {
			runWalk();
		}, DEBOUNCE_MS);

		const ac = new AbortController();
		const matches: SearchMatch[] = [];
		let lastFlush = 0;
		let visitedLocal = 0;
		let totalLocal = 0;

		const flush = (forceFinal: boolean) => {
			matches.sort((a, b) => b.score - a.score);
			if (matches.length > MAX_RESULTS) {
				matches.length = MAX_RESULTS;
			}
			onChangeRef.current({
				query,
				matches: matches.slice(),
				walking: !forceFinal,
				visited: visitedLocal,
				totalKnown: totalLocal,
			});
		};

		const runWalk = async () => {
			setWalking(true);
			setVisited(0);
			setTotalKnown(0);

			try {
				const iter = walkTree(root, {
					signal: ac.signal,
					cheap: !deep,
					onProgress: (v, t) => {
						visitedLocal = v;
						totalLocal = t;
						// Throttle React updates.
						const now = performance.now();
						if (now - lastFlush > RESULT_FLUSH_MS) {
							lastFlush = now;
							setVisited(v);
							setTotalKnown(t);
							flush(false);
						}
					},
				});

				for await (const walked of iter) {
					if (ac.signal.aborted) return;
					const m = scoreNode(query, walked);
					if (m) matches.push(m);
				}
				if (ac.signal.aborted) return;
			} finally {
				if (!ac.signal.aborted) {
					setWalking(false);
					setVisited(visitedLocal);
					setTotalKnown(totalLocal);
					flush(true);
				}
			}
		};

		return () => {
			window.clearTimeout(debounceHandle);
			ac.abort();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query, deep, root, walkVersion]);

	const hasQuery = query.length > 0;

	return (
		<div className="flex flex-col gap-1">
			<InputGroup className="h-9">
				<InputGroupAddon>
					{walking ? (
						<Spinner className="size-3.5 text-muted-foreground" />
					) : (
						<SearchIcon className="size-3.5 text-muted-foreground" />
					)}
				</InputGroupAddon>
				<InputGroupInput
					placeholder="Search files…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							e.preventDefault();
							setQuery('');
						}
					}}
					aria-label="Search files in archive"
				/>
				{hasQuery && (
					<InputGroupAddon align="inline-end">
						<button
							type="button"
							onClick={() => setQuery('')}
							className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
							aria-label="Clear search"
						>
							<XIcon className="size-3.5" />
						</button>
					</InputGroupAddon>
				)}
			</InputGroup>

			<div className="flex items-center justify-between gap-2 px-1 text-[10px] text-muted-foreground">
				<span className="truncate">
					{walking
						? `Searching ${visited.toLocaleString()}${
								totalKnown > visited
									? ` / ${totalKnown.toLocaleString()}`
									: ''
							} entries…`
						: hasQuery
							? null
							: null}
				</span>
				<Button
					type="button"
					size="sm"
					variant={deep ? 'default' : 'ghost'}
					className={cn(
						'h-5 shrink-0 gap-1 px-1.5 text-[10px] font-medium',
						!deep && 'text-muted-foreground hover:text-foreground',
					)}
					onClick={() => setDeep((d) => !d)}
					title="Search inside encrypted/compressed containers (NCA, NCZ). Slower."
				>
					<LayersIcon className="size-3" />
					Deep
				</Button>
			</div>
		</div>
	);
}

/**
 * Score a walked node against the query. Returns `null` if no
 * match. We score against the leaf name only (per requirements:
 * "filename-only").
 */
function scoreNode(query: string, walked: WalkedNode): SearchMatch | null {
	const m: MatchResult | null = fuzzyMatch(query, walked.node.name);
	if (!m) return null;
	return {
		node: walked.node,
		pathIds: walked.pathIds,
		pathNames: walked.pathNames,
		score: m.score,
		indexes: m.indexes,
	};
}
