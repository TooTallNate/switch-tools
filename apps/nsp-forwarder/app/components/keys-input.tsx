import { Link } from '@remix-run/react';

export function KeysTooltip() {
	return (
		<>
			The <code>prod.keys</code> file generated on your Nintendo Switch by
			the{' '}
			<Link target="blank" to="https://github.com/shchmue/Lockpick_RCM">
				Lockpick_RCM
			</Link>{' '}
			app
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
