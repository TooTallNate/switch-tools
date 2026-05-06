/**
 * Filename-only fuzzy search across the archive tree.
 *
 * Two pieces:
 *
 * 1. {@link walkTree} — an async generator that lazily expands every
 *    container in the tree and yields `{ node, path }` for each
 *    visited node. Honours a cancellation token and a "cheap" flag
 *    (the latter skips potentially-expensive NCA / NCZ expansion
 *    unless the user has already triggered it interactively).
 *
 * 2. {@link fuzzyMatch} — an fzf-style scoring function. Given a
 *    needle and a haystack, returns `null` if the needle's characters
 *    can't be found in order in the haystack, or a `{ score, ranges }`
 *    object marking which characters were the matches. Higher score =
 *    better match, with bonuses for contiguous runs, prefix matches,
 *    and word boundaries — so `mnnro` against `["main.nro", "minor.txt",
 *    "config/random.nro"]` ranks `main.nro` first.
 *
 * Combine them: walk the tree once (expensive on first call, cached
 * thereafter via `node._children`), score every visited node's name,
 * sort by score descending, take the top N. The UI surfaces matches
 * as they stream in, so users see incremental results without
 * waiting for the entire walk to finish.
 */

import type { Node } from './archive';

// ============================================================================
// Tree walking
// ============================================================================

export interface WalkOptions {
	/**
	 * Aborted signal to halt walking early. The generator stops on
	 * the next iteration after the signal fires; in-flight
	 * `getChildren()` calls aren't actively cancelled (they continue
	 * to completion in the background, but their results are
	 * discarded).
	 */
	signal?: AbortSignal;
	/**
	 * If `true` (default), skip containers whose expansion would
	 * trigger heavy work (NCA decryption, NCZ decompression) unless
	 * the user has already expanded them interactively (in which case
	 * `node._children` is populated and we walk the cached result).
	 *
	 * If `false`, walk every container regardless of cost. This is
	 * the "deep search" mode.
	 */
	cheap?: boolean;
	/**
	 * Optional callback fired each time a new container starts
	 * expanding. Used by the UI to display "Searching N/M…"
	 * progress. The total grows as we discover more containers,
	 * which is fine — the UI can show "found N so far".
	 */
	onProgress?: (visited: number, totalKnown: number) => void;
}

export interface WalkedNode {
	node: Node;
	/** Names of every ancestor from root → leaf, including this node. */
	pathNames: string[];
	/** Stable IDs of every ancestor from root → leaf. */
	pathIds: string[];
}

/**
 * "Heavy" container kinds — expanding these triggers crypto / zstd /
 * other meaningful work. We only walk into them in deep mode, OR if
 * the user has already expanded them interactively (= node._children
 * is populated).
 */
function isHeavyContainer(node: Node): boolean {
	// NCA expansion does AES-XTS header decrypt + section parsing.
	// (NCZ files use kind='nca' too — same code path.)
	return node.kind === 'nca';
}

/**
 * Async generator that walks the entire archive tree, yielding every
 * node it visits in pre-order (parents before children). Containers
 * that fail to expand (missing keys, malformed metadata, etc.) are
 * silently skipped — search shouldn't break just because one corner
 * of the tree errors out.
 *
 * Yields the root itself first, so a caller can match on the root's
 * name too if they want.
 */
export async function* walkTree(
	root: Node,
	opts: WalkOptions = {},
): AsyncGenerator<WalkedNode, void, void> {
	const { signal, cheap = true, onProgress } = opts;
	let visited = 0;
	let totalKnown = 1; // root counts

	// Iterative DFS using a stack. Each stack frame is a node + its
	// pre-computed path; we push children in reverse so the iteration
	// order matches recursive pre-order (left-to-right).
	const stack: WalkedNode[] = [
		{ node: root, pathNames: [root.name], pathIds: [root.id] },
	];

	while (stack.length > 0) {
		if (signal?.aborted) return;
		const frame = stack.pop()!;
		visited++;
		yield frame;
		onProgress?.(visited, totalKnown);

		if (!frame.node.isContainer || !frame.node.getChildren) continue;

		// Decide whether to descend into this container.
		const alreadyExpanded = !!frame.node._children;
		if (cheap && isHeavyContainer(frame.node) && !alreadyExpanded) {
			// Skip the body of heavy containers in cheap mode — we
			// still yielded the container itself (above), so its
			// name participates in matching.
			continue;
		}

		let children: Node[];
		try {
			// Use the same caching the tree UI uses: if children are
			// already resolved, reuse them; otherwise expand and
			// cache for future walks AND for tree rendering.
			if (frame.node._children) {
				children = frame.node._children;
			} else {
				children = await frame.node.getChildren();
				frame.node._children = children;
			}
		} catch (err) {
			frame.node._childrenError =
				err instanceof Error ? err : new Error(String(err));
			continue;
		}

		totalKnown += children.length;
		// Push in reverse so that on `pop()` we visit them in order.
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			stack.push({
				node: child,
				pathNames: [...frame.pathNames, child.name],
				pathIds: [...frame.pathIds, child.id],
			});
		}
	}
}

// ============================================================================
// Fuzzy matching (fzf-lite)
// ============================================================================

export interface MatchResult {
	/**
	 * Higher = better. Range is unbounded; useful only for sorting
	 * relative to other matches.
	 */
	score: number;
	/**
	 * Indexes (into the haystack) of every character that matched a
	 * needle character. Always sorted ascending.
	 */
	indexes: number[];
}

/**
 * Score how well `needle` matches `haystack` using an fzf-style
 * algorithm:
 *
 *   - Characters of the needle must appear in `haystack` in order
 *     (gaps allowed).
 *   - Contiguous matches score better than gappy ones.
 *   - Prefix matches (haystack[0]) get a bonus.
 *   - Word-boundary matches (after `/`, `_`, `-`, `.`, ` `, or a
 *     transition from lower→upper) get a bonus.
 *
 * Returns `null` if `haystack` doesn't contain all needle characters
 * in order. Empty needle returns score=0 with no indexes (so callers
 * can use it as a "match all" sentinel).
 *
 * This is greedy left-to-right rather than full optimal-parsing —
 * fzf does optimal parsing (DP) for its top-N, but for our scale
 * (a few thousand filenames per archive) the greedy version is
 * plenty good and runs in O(n) per filename.
 */
export function fuzzyMatch(needle: string, haystack: string): MatchResult | null {
	if (needle.length === 0) return { score: 0, indexes: [] };
	if (needle.length > haystack.length) return null;

	const needleLower = needle.toLowerCase();
	const haystackLower = haystack.toLowerCase();

	const indexes: number[] = [];
	let nIdx = 0;
	for (let hIdx = 0; hIdx < haystackLower.length && nIdx < needleLower.length; hIdx++) {
		if (haystackLower[hIdx] === needleLower[nIdx]) {
			indexes.push(hIdx);
			nIdx++;
		}
	}
	if (nIdx < needleLower.length) return null;

	// --- Greedy back-pass to coalesce contiguous match runs. ---
	// The forward pass picks the earliest match for each needle char,
	// which is fine for correctness but loses runs like "main" against
	// "..main..bar". Walk backwards: for each needle char, find the
	// LATEST possible position that still leaves room for the rest.
	// This produces match runs that prefer to land contiguously near
	// the end, which matches fzf's behaviour.
	const tightened = tightenMatch(needleLower, haystackLower);
	const finalIndexes = tightened ?? indexes;

	const score = scoreMatch(haystack, finalIndexes);
	return { score, indexes: finalIndexes };
}

/**
 * For each needle character, find the latest haystack position
 * that still allows the rest of the needle to fit. Returns indexes
 * tightened to the right (i.e. preferring the latest contiguous run).
 */
function tightenMatch(needle: string, haystack: string): number[] | null {
	const indexes: number[] = new Array(needle.length);
	let hIdx = haystack.length - 1;
	for (let nIdx = needle.length - 1; nIdx >= 0; nIdx--) {
		while (hIdx >= 0 && haystack[hIdx] !== needle[nIdx]) hIdx--;
		if (hIdx < 0) return null;
		indexes[nIdx] = hIdx;
		hIdx--;
	}
	return indexes;
}

/** Score a match given the haystack and the matched-character indexes. */
function scoreMatch(haystack: string, indexes: number[]): number {
	if (indexes.length === 0) return 0;

	const PREFIX_BONUS = 50;
	const BOUNDARY_BONUS = 30;
	const CONTIGUOUS_BONUS = 20;
	const CAMEL_BONUS = 25;
	const GAP_PENALTY = -2;
	const FILENAME_BONUS = 15; // Match in filename rather than directory part

	const lastSlash = haystack.lastIndexOf('/');
	const filenameStart = lastSlash + 1;

	let score = 0;
	let prevIdx = -2; // -2 so prevIdx + 1 != indexes[0] when indexes[0] = 0
	for (let i = 0; i < indexes.length; i++) {
		const idx = indexes[i];
		const ch = haystack[idx];
		const prevCh = idx > 0 ? haystack[idx - 1] : '';

		// Prefix of full haystack — also implicitly a word boundary,
		// so we also award the BOUNDARY_BONUS so this case ranks
		// alongside other after-separator matches.
		if (idx === 0) score += PREFIX_BONUS + BOUNDARY_BONUS;
		// Prefix of the filename portion (after last slash). The
		// preceding `/` already triggers the BOUNDARY_BONUS check
		// below, so we just add the prefix bonus here.
		else if (idx === filenameStart) score += PREFIX_BONUS;

		// Word boundary: previous char is a separator.
		if (idx > 0 && /[\/_\-. ]/.test(prevCh)) score += BOUNDARY_BONUS;
		// CamelCase boundary: lower → upper.
		if (
			idx > 0 &&
			ch >= 'A' &&
			ch <= 'Z' &&
			prevCh >= 'a' &&
			prevCh <= 'z'
		)
			score += CAMEL_BONUS;

		// Match falls inside the filename (vs. directory components).
		if (idx >= filenameStart) score += FILENAME_BONUS;

		// Contiguous with previous match.
		if (idx === prevIdx + 1) score += CONTIGUOUS_BONUS;
		// Penalty for the gap between matches.
		else if (prevIdx >= 0) score += (idx - prevIdx - 1) * GAP_PENALTY;

		prevIdx = idx;
	}
	// Slight preference for shorter haystacks when scores are tied —
	// "nro" should rank "a.nro" above "very/long/path/main.nro".
	score -= haystack.length * 0.1;
	return score;
}
