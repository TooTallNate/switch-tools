import type { LinksFunction, MetaFunction } from '@remix-run/server-runtime';
import {
	Links,
	LiveReload,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from '@remix-run/react';

import { Header } from '~/components/header';

import rootStyles from '~/styles/root.css';
import headerStyles from '~/styles/header.css';
import footerStyles from '~/styles/footer.css';

export const meta: MetaFunction = () => ({
	charset: 'utf-8',
	title: 'NSP Forwarder Generator',
	viewport: 'width=device-width,initial-scale=1',
});

export const links: LinksFunction = () => {
	return [
		{ rel: 'stylesheet', href: rootStyles },
		{ rel: 'stylesheet', href: headerStyles },
		{ rel: 'stylesheet', href: footerStyles },
	];
}

export default function App() {
	return (
		<html lang="en">
			<head>
				<Meta />
				<Links />
			</head>
			<body>
				<div className="content">
					<Header as="h2">NSP Forwarder</Header>
					<Header as="h1">Generator</Header>
					<Outlet />
				</div>
				<div className="footer">
					<span>Created by <a href="https://twitter.com/tootallnate">@TooTallNate</a></span>
					<span><a href="https://github.com/TooTallNate/nsp-forwarder">Source Code</a></span>
					<span>Hosted by <a href="https://vercel.com">Vercel</a></span>
				</div>
				<ScrollRestoration />
				<Scripts />
				<LiveReload />
			</body>
		</html>
	);
}
