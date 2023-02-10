import type { ActionArgs } from '@remix-run/server-runtime';
import { generateNsp } from '~/lib/generate.server';

export function action({ request }: ActionArgs) {
	return generateNsp(request);
}
