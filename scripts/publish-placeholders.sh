#!/usr/bin/env bash
#
# Publish a placeholder 0.0.0 release of every workspace package that isn't on npm
# yet, then configure trusted publishing (OIDC from .github/workflows/release.yml)
# for it. npm can only set up trusted publishing for a package that already exists,
# and the release workflow publishes without a token, so new packages need this once.
#
# Safe to re-run: packages whose only release is the placeholder get trusted
# publishing if they don't have it yet (e.g. after an interrupted run).
#
# Usage: scripts/publish-placeholders.sh [--dry-run]
#
# Needs an `npm login` with publish rights to the @tootallnate scope. Each publish
# and trust change may ask for 2FA in the browser; tick "skip 2FA for 5 minutes" to
# get through the list without a prompt per package.
#
# A placeholder is only package.json + README, at version 0.0.0. Every new package
# must have a version above 0.0.0, or a pending changeset that bumps it: the release
# skips versions that already exist, so a package left at 0.0.0 would stay a
# placeholder.

set -euo pipefail

REPO="TooTallNate/switch-tools"
WORKFLOW="release.yml"
DRY_RUN=""
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

cd "$(dirname "$0")/.."

# Always the public registry, whatever ~/.npmrc points at (e.g. a company proxy).
export NPM_CONFIG_REGISTRY="https://registry.npmjs.org/"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Run npm outside the repo, so its pnpm-only .npmrc settings don't warn.
npm_() { (cd "$tmp" && npm "$@"); }

PLACEHOLDER="Placeholder release. See https://github.com/$REPO"

[[ -n "$DRY_RUN" ]] || npm_ whoami >/dev/null 2>&1 || { echo "Not logged in to npm: run \`npm login\` first." >&2; exit 1; }

trust() {
	local name="$1"
	if [[ -n "$DRY_RUN" ]]; then
		echo "    would trust $REPO ($WORKFLOW) for $name"
		return
	fi
	local existing
	existing="$(npm_ trust list "$name" --json 2>/dev/null | tr -d '[:space:]')"
	# Only a real entry counts; anything else (an error, or a package npm hasn't caught up on) doesn't.
	if [[ "$existing" != *'"repository":"'"$REPO"'"'* ]]; then
		npm_ trust github "$name" --file "$WORKFLOW" --repository "$REPO" --allow-publish --yes
	else
		echo "    already trusted"
	fi
}

for pkg in packages/*/package.json; do
	dir="$(dirname "$pkg")"
	read -r name version private < <(node -p "const p = require('./$pkg'); [p.name, p.version, !!p.private].join(' ')")
	[[ "$private" == "true" ]] && continue
	if versions="$(npm_ view "$name" versions --json 2>/dev/null)"; then
		# Already on npm: finish the setup if all it has is our placeholder.
		versions="$(echo "$versions" | tr -d '[:space:]')"
		if [[ "$versions" == '["0.0.0"]' || "$versions" == '"0.0.0"' ]] &&
			[[ "$(npm_ view "$name@0.0.0" description 2>/dev/null)" == "$PLACEHOLDER" ]]; then
			echo "==> $name (placeholder already published)"
			trust "$name"
		fi
		continue
	fi

	if [[ "$version" == "0.0.0" ]] && ! grep -qs "\"$name\"" .changeset/*.md; then
		echo "warning: $name is at 0.0.0 with no pending changeset, so its real release would be skipped" >&2
	fi

	echo "==> $name"
	out="$tmp/${name//\//__}"
	mkdir -p "$out"
	PLACEHOLDER="$PLACEHOLDER" node -e '
		const [name, dir, repo, out] = process.argv.slice(1);
		const fs = require("node:fs");
		const pkg = {
			name,
			version: "0.0.0",
			description: process.env.PLACEHOLDER,
			license: "MIT",
			// npm's normalized form, so publishing doesn't warn about fixing it.
			repository: { type: "git", url: `git+https://github.com/${repo}.git`, directory: dir },
		};
		fs.writeFileSync(`${out}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
		fs.writeFileSync(`${out}/README.md`, `# ${name}\n\nPlaceholder release, reserving the name so trusted publishing can be set up.\nThe real package is published from https://github.com/${repo}/tree/main/${dir}\n`);
	' "$name" "$dir" "$REPO" "$out"

	if [[ -n "$DRY_RUN" ]]; then
		(cd "$out" && npm publish --access public --dry-run >/dev/null 2>&1)
		echo "    would publish $name@0.0.0"
	else
		# Only stderr is captured: npm offers its browser 2FA prompt only when
		# stdin and stdout are a terminal. A rejection for an existing version
		# means an earlier run published it and npm hasn't caught up yet.
		log="$tmp/publish.log"
		if ! (cd "$out" && npm publish --access public 2> >(tee "$log" >&2)); then
			grep -qiE "previously published|cannot publish over" "$log" || exit 1
			echo "    already published"
		fi
	fi
	trust "$name"
done
