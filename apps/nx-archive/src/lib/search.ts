/**
 * Filename-only search across the archive tree.
 *
 * Two pieces:
 *
 * 1. {@link walkTree} — an async generator that lazily expands every
 *    container in the tree and yields `{ node, path }` for each
 *    visited node. Honours a cancellation token and a "cheap" flag
 *    (the latter skips potentially-expensive NCA / NCZ expansion
 *    unless the user has already triggered it interactively).
 *
 * 2. {@link fuzzyMatch} — a strict **substring-or-acronym** match.
 *    The previous fzf-style fuzzy match allowed arbitrary gaps,
 *    which produced too many low-quality results (e.g. `bik`
 *    matching `bombdrop_index_keys.json` because the three letters
 *    happened to appear in order). The new rule is much more
 *    predictable: either the needle is a contiguous substring of
 *    the filename, or every needle character lands on a word
 *    boundary (start, after `/_-.` or ` `, or camelCase
 *    transitions) so `pst` matches `PauseScreenText`. Substring
 *    matches always outrank acronym matches; within each category
 *    matches closer to the filename and at boundaries rank higher.
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
// Substring-or-acronym matching
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
 * Match `needle` against `haystack` using a strict
 * **substring-or-acronym** rule:
 *
 *   - **Substring match**: the needle appears as a contiguous
 *     case-insensitive substring of the haystack. Covers the
 *     overwhelming majority of real searches (`bik`, `.mp4`,
 *     `cutscene`, `materials/`, etc.).
 *   - **Acronym match**: the needle's characters appear in
 *     order in the haystack, AND every matched character lands
 *     at a "word boundary" — start of the haystack, the start of
 *     the filename portion (after the last `/`), immediately after
 *     a separator (`/`, `_`, `-`, `.`, ` `), or at a camelCase
 *     transition. So `pst` matches `PauseScreenText` and `mn`
 *     matches `main.nro`, but `bik` does NOT match a random
 *     filename where `b`, `i`, `k` happen to occur far apart.
 *
 * Returns `null` for non-matches. Empty needle returns
 * `score=0` (match-all sentinel for incremental typing).
 *
 * Substring matches outrank acronym matches; within each rule,
 * matches closer to the filename (vs. directory components) and
 * matches at boundaries rank higher.
 *
 * This is intentionally stricter than the previous fzf-style
 * fuzzy match, which allowed arbitrary gaps and produced too
 * many low-quality results (e.g. `bik` matching
 * `bombdrop_index_keys.json` because the three letters happened
 * to appear in order). Use whole-substring or
 * acronym/initial-letter typing for predictable results.
 */
export function fuzzyMatch(needle: string, haystack: string): MatchResult | null {
	if (needle.length === 0) return { score: 0, indexes: [] };
	if (needle.length > haystack.length) return null;

	const needleLower = needle.toLowerCase();
	const haystackLower = haystack.toLowerCase();

	// 1. Try substring match first (always preferred when available).
	const substringIdx = haystackLower.indexOf(needleLower);
	if (substringIdx >= 0) {
		const indexes: number[] = new Array(needle.length);
		for (let i = 0; i < needle.length; i++) indexes[i] = substringIdx + i;
		// Substring matches get a big base bonus so they always
		// outrank acronym matches.
		const score = SUBSTRING_BASE_BONUS + scoreMatch(haystack, indexes);
		return { score, indexes };
	}

	// 2. Try acronym match — each needle char must land on a word
	// boundary. We walk haystack left-to-right collecting candidate
	// positions (haystack[0] and any char immediately after a
	// separator or at a camelCase transition) and consume needle
	// chars greedily from those.
	const acronym = matchAcronym(needleLower, haystackLower, haystack);
	if (acronym !== null) {
		const score = scoreMatch(haystack, acronym);
		return { score, indexes: acronym };
	}

	return null;
}

/**
 * Returns matched indexes when every character of `needleLower`
 * lands on a word boundary in `haystackLower`, in order. The
 * `haystackOriginal` (preserved casing) is used for the camelCase
 * boundary check. Returns `null` if no such ordering exists.
 *
 * Walks haystack greedily — the same boundary character can only
 * be consumed once, so a needle longer than the haystack's
 * boundary count will never match.
 */
function matchAcronym(
	needleLower: string,
	haystackLower: string,
	haystackOriginal: string,
): number[] | null {
	const out: number[] = [];
	let nIdx = 0;
	for (let hIdx = 0; hIdx < haystackLower.length && nIdx < needleLower.length; hIdx++) {
		if (!isWordBoundary(haystackOriginal, hIdx)) continue;
		if (haystackLower[hIdx] === needleLower[nIdx]) {
			out.push(hIdx);
			nIdx++;
		}
	}
	if (nIdx < needleLower.length) return null;
	return out;
}

/**
 * True when `haystack[i]` starts a "word" — i.e. is one of:
 *
 *   - The very first character.
 *   - Immediately preceded by a separator (`/`, `_`, `-`, `.`, ` `).
 *   - An uppercase letter immediately preceded by a lowercase
 *     letter or digit (camelCase / PascalCase boundary).
 *   - A digit immediately preceded by a letter (e.g. the `4` in
 *     `Player4` is a token start — supports queries like
 *     `mp4` matching `MediaPlayer4`).
 *   - A letter immediately preceded by a digit (e.g. the `K`
 *     in `4K` — supports `4K` queries).
 */
function isWordBoundary(haystack: string, i: number): boolean {
	if (i === 0) return true;
	const prev = haystack[i - 1];
	if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ')
		return true;
	const ch = haystack[i];
	const prevIsLetter = isAsciiLetter(prev);
	const prevIsDigit = prev >= '0' && prev <= '9';
	const chIsLetter = isAsciiLetter(ch);
	const chIsDigit = ch >= '0' && ch <= '9';
	// camelCase / PascalCase: lower|digit → Upper.
	if (chIsLetter && ch >= 'A' && ch <= 'Z' && ((prev >= 'a' && prev <= 'z') || prevIsDigit)) {
		return true;
	}
	// letter → digit transition (e.g. Player4).
	if (chIsDigit && prevIsLetter) return true;
	// digit → letter transition (e.g. 4K).
	if (chIsLetter && prevIsDigit) return true;
	return false;
}

function isAsciiLetter(ch: string): boolean {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

const SUBSTRING_BASE_BONUS = 1000;

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
