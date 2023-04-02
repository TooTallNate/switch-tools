import type { LinksFunction, MetaFunction } from '@vercel/remix';
import {
	Link,
	Links,
	LiveReload,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useLoaderData,
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

export function loader() {
	const isDev = !process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'dev1';
	return { isDev };
}

export const links: LinksFunction = () => {
	return [
		{ rel: 'stylesheet', href: rootStyles },
		{ rel: 'stylesheet', href: headerStyles },
		{ rel: 'stylesheet', href: footerStyles },
	];
};

export default function App() {
	const { isDev } = useLoaderData<typeof loader>();
	return (
		<html lang="en" className="dark-theme">
			<head>
				<Meta />
				<Links />
			</head>
			<body>
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
				{!isDev ? <Analytics /> : null}
			</body>
		</html>
	);
}
