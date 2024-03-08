import { LinksFunction, MetaFunction } from '@vercel/remix';
import {
	Link,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useLocation,
} from '@remix-run/react';
import { Analytics } from '@vercel/analytics/react';

import { Header } from '~/components/header';

import radixWhiteA from '@radix-ui/colors/whiteA.css?url';
import radixBlackA from '@radix-ui/colors/blackA.css?url';
import radixMauve from '@radix-ui/colors/mauveDark.css?url';
import radixViolet from '@radix-ui/colors/violetDark.css?url';
import rootStyles from '~/styles/root.css?url';
import headerStyles from '~/styles/header.css?url';
import footerStyles from '~/styles/footer.css?url';
import { Vercel } from '~/components/vercel';
import { GitHubLogoIcon } from '@radix-ui/react-icons';

export const config = { runtime: 'edge' };

export const meta: MetaFunction = () => [
	{ title: 'NSP Forwarder Generator' },
	{
		name: 'description',
		content:
			'Create "NRO to NSP forwarders" for your modded Nintendo Switch.',
	},
];

export const links: LinksFunction = () => {
	return [
		{ rel: 'stylesheet', href: radixWhiteA },
		{ rel: 'stylesheet', href: radixBlackA },
		{ rel: 'stylesheet', href: radixMauve },
		{ rel: 'stylesheet', href: radixViolet },
		{ rel: 'stylesheet', href: rootStyles },
		{ rel: 'stylesheet', href: headerStyles },
		{ rel: 'stylesheet', href: footerStyles },
	];
};

export default function App() {
	const { pathname } = useLocation();
	return (
		<html lang="en" className="dark-theme">
			<head>
				<meta charSet="utf-8" />
				<meta
					name="viewport"
					content="width=device-width, initial-scale=1"
				/>
				<Meta />
				<link
					rel="canonical"
					href={`https://nsp-forwarder.n8.io${pathname}`}
				/>
				<Links />
			</head>
			<body>
				<div className="bg"></div>
				<div className="bg-fade"></div>
				<header>
					<Link to="/" className="header">
						<Header as="h2">NSP Forwarder</Header>
						<Header as="h1">Generator</Header>
					</Link>
				</header>
				<div className="content">
					<Outlet />
				</div>
				<div className="footer">
					<span className="source">
						<a
							target="_blank"
							href="https://github.com/TooTallNate/switch-tools/tree/main/apps/nsp-forwarder"
						>
							Source Code
							<GitHubLogoIcon />
						</a>
					</span>
					<span>
						<a target="_blank" href="https://vercel.com">
							Hosted by <Vercel />
						</a>
					</span>
				</div>
				<ScrollRestoration />
				<Scripts />
				<Analytics />
			</body>
		</html>
	);
}
