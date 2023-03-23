import type { LinksFunction, MetaFunction } from '@vercel/remix';
import {
	Links,
	LiveReload,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from '@remix-run/react';
import { Analytics } from '@vercel/analytics/react';

import { Header } from '~/components/header';

import rootStyles from '~/styles/root.css';
import headerStyles from '~/styles/header.css';
import footerStyles from '~/styles/footer.css';
import { Vercel } from '~/components/vercel';
import { GitHubLogoIcon } from '@radix-ui/react-icons';

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
};

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
					<span className="source">
						<a
							target="_blank"
							href="https://github.com/TooTallNate/nsp-forwarder"
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
				<LiveReload />
				<Analytics />
			</body>
		</html>
	);
}
