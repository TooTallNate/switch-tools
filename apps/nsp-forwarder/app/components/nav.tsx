import { Link, NavLink, useLocation } from '@remix-run/react';
import { Checkbox } from '~/components/ui/checkbox';
import { cn } from '~/lib/utils';

export interface NavProps {
	advancedMode?: boolean;
}

export function Nav({ advancedMode }: NavProps) {
	const { pathname, search } = useLocation();

	const params = new URLSearchParams(search);
	if (advancedMode) {
		params.delete('advanced');
	} else {
		params.set('advanced', '1');
	}
	const toggledAdvanceModeSearch = `?${String(params).replace(
		'advanced=1',
		'advanced'
	)}`;

	const linkClasses =
		'block cursor-pointer select-none rounded-md px-3 py-2 text-sm font-medium no-underline transition-colors hover:bg-primary/80 hover:text-primary-foreground text-foreground';
	const activeLinkClasses = 'bg-primary text-primary-foreground';

	return (
		<nav className="flex items-center gap-1 rounded-md border border-border/50 bg-muted/30 p-1">
			<NavLink
				className={({ isActive }) =>
					cn(
						linkClasses,
						isActive && pathname === '/' && activeLinkClasses
					)
				}
				to={`/${search}`}
				preventScrollReset
			>
				NRO Forwarder
			</NavLink>

			<NavLink
				className={({ isActive }) =>
					cn(linkClasses, isActive && activeLinkClasses)
				}
				to={`/retroarch${search}`}
				preventScrollReset
			>
				RetroArch Forwarder
			</NavLink>

			<Link
				className={cn(
					linkClasses,
					'hover:bg-accent hover:text-accent-foreground'
				)}
				to={`${pathname}${toggledAdvanceModeSearch}`}
				preventScrollReset
			>
				<label className="flex cursor-pointer items-center gap-1.5 select-none">
					Advanced Mode
					<Checkbox checked={advancedMode} className="ml-1" />
				</label>
			</Link>
		</nav>
	);
}
