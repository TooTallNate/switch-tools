import type { ActionArgs } from '@vercel/remix';
import { generateNsp } from '~/lib/generate.server';

export function action({ request }: ActionArgs) {
	return generateNsp(request);
}
