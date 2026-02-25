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

//import { Header } from '~/components/header';

import rootStyles from '~/styles/root.css?url';
//import headerStyles from '~/styles/header.css?url';
//import footerStyles from '~/styles/footer.css?url';

export const meta: MetaFunction = () => [
	{ title: 'NRO Editor' },
	{
		name: 'description',
		content:
			'Edit NRO Nintendo Switch homebrew application metadata and RomFS files.',
	},
];

export const links: LinksFunction = () => {
	return [
		//{ rel: 'stylesheet', href: radixWhiteA },
		//{ rel: 'stylesheet', href: radixBlackA },
		//{ rel: 'stylesheet', href: radixMauve },
		//{ rel: 'stylesheet', href: radixViolet },
		{ rel: 'stylesheet', href: rootStyles },
		//{ rel: 'stylesheet', href: headerStyles },
		//{ rel: 'stylesheet', href: footerStyles },
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
					href={`https://nro-editor.n8.io${pathname}`}
				/>
				<Links />
			</head>
			<body>
				<header>
					<Link to="/" className="header">
						<h1>NRO Editor</h1>
					</Link>
				</header>
				<div className="content">
					<Outlet />
				</div>
				<div className="footer">
					{/*
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
	</span>*/}
				</div>
				<ScrollRestoration />
				<Scripts />
				<Analytics />
			</body>
		</html>
	);
}
