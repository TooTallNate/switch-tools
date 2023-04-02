import { NavLink, useLocation } from '@remix-run/react';
import { CheckIcon } from '@radix-ui/react-icons';
import * as Checkbox from '@radix-ui/react-checkbox';
import * as NavigationMenu from '@radix-ui/react-navigation-menu';

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

	return (
		<NavigationMenu.Root className="NavigationMenuRoot">
			<NavigationMenu.List className="NavigationMenuList">
				<NavigationMenu.Item>
					<NavLink
						className="NavigationMenuLink"
						to={`/${search}`}
						preventScrollReset
					>
						NRO Forwarder
					</NavLink>
				</NavigationMenu.Item>

				<NavigationMenu.Item>
					<NavLink
						className="NavigationMenuLink"
						to={`/retroarch${search}`}
						preventScrollReset
					>
						RetroArch Forwarder
					</NavLink>
				</NavigationMenu.Item>

				<NavigationMenu.Item>
					<NavLink
						to={`${pathname}${toggledAdvanceModeSearch}`}
						preventScrollReset
					>
						<label
							className="NavigationMenuLink"
							style={{ display: 'flex', alignItems: 'center' }}
						>
							Advanced Mode
							<Checkbox.Root
								className="CheckboxRoot"
								checked={advancedMode}
							>
								<Checkbox.Indicator className="CheckboxIndicator">
									<CheckIcon />
								</Checkbox.Indicator>
							</Checkbox.Root>
						</label>
					</NavLink>
				</NavigationMenu.Item>
			</NavigationMenu.List>
		</NavigationMenu.Root>
	);
}
