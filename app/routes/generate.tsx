import type { ActionArgs } from '@remix-run/server-runtime';
import { useCatch } from '@remix-run/react';

import { generateNsp } from '~/lib/generate.server';

export function action({ request }: ActionArgs) {
	return generateNsp(request);
}

export function CatchBoundary() {
	const caught = useCatch();

	return (
		<div>
			<h1>Caught</h1>
			<p>Status: {caught.status}</p>
			<pre>
				<code>{JSON.stringify(caught.data, null, 2)}</code>
			</pre>
		</div>
	);
}

export default function Generate() {
	return <div>GET</div>;
}
