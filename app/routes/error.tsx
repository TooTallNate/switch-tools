import { useLoaderData } from '@remix-run/react';
import { json, redirect, type LoaderArgs } from '@vercel/remix';
import type { ErrorData } from '~/lib/generate.server';

import { getSession, commitSession } from '~/session.server';

export const config = { runtime: 'edge' };

export async function loader({ request }: LoaderArgs) {
	const session = await getSession(request.headers.get('Cookie'));
	const error: ErrorData = session.get('error');
	const headers = {
		'Set-Cookie': await commitSession(session),
	};
	if (error) {
		return json(error, { headers });
	}
	return redirect('/', { headers });
}

export default function ErrorPage() {
	const error = useLoaderData<typeof loader>();
	return (
		<div className="error">
			<p
				style={{
					textAlign: 'center',
					fontWeight: 'bold',
					color: '#fdd40f',
					fontSize: '1.2em',
				}}
			>
				⚠️ There was a problem generating your NSP forwarder ⚠️
			</p>
			<pre>
				<code>
					<span className="stderr">{error.message + '\n'}</span>
					{error.logs.map(({ type, data }, i) => (
						<span key={i} className={type}>
							{data}
						</span>
					))}
				</code>
			</pre>
		</div>
	);
}
