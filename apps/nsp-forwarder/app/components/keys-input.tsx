import { Link } from '@remix-run/react';

export function KeysTooltip() {
	return (
		<>
			The <code>prod.keys</code> file generated on your Nintendo Switch by
			the{' '}
			<Link
				target="blank"
				to="https://vps.suchmeme.nl/git/mudkip/Lockpick_RCM/releases"
			>
				Lockpick_RCM
			</Link>{' '}
			payload
		</>
	);
}

export function KeysPlaceholder() {
	return (
		<>
			Click to select your <code>prod.keys</code> file…
		</>
	);
}
