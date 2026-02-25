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
import { Github } from 'lucide-react';

import { Header } from '~/components/header';
import { TooltipProvider } from '~/components/ui/tooltip';

import tailwindStyles from '~/tailwind.css?url';
import rootStyles from '~/styles/root.css?url';
import headerStyles from '~/styles/header.css?url';

import { Vercel } from '~/components/vercel';

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
		{ rel: 'stylesheet', href: tailwindStyles },
		{ rel: 'stylesheet', href: rootStyles },
		{ rel: 'stylesheet', href: headerStyles },
	];
};

export default function App() {
	const { pathname } = useLocation();
	return (
		<html lang="en" className="dark">
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
				<TooltipProvider>
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
					<footer className="mt-auto flex w-full items-center justify-between border-t border-white/20 bg-white/10 px-3 py-2 text-sm">
						<a
							className="inline-flex items-center gap-1.5 text-white no-underline hover:underline"
							target="_blank"
							href="https://github.com/TooTallNate/switch-tools/tree/main/apps/nsp-forwarder"
						>
							Source Code
							<Github className="size-[1.1em]" />
						</a>
						<a
							className="inline-flex items-center gap-1.5 text-white no-underline hover:underline"
							target="_blank"
							href="https://vercel.com"
						>
							Hosted by
							<Vercel className="h-[1em] w-auto" />
						</a>
					</footer>
				</TooltipProvider>
				<ScrollRestoration />
				<Scripts />
				<Analytics />
			</body>
		</html>
	);
}
