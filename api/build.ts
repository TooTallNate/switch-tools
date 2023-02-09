import { tmpdir } from 'os';
import { mkdtemp, copy } from 'fs-extra';
import { IncomingMessage, ServerResponse } from 'http';

export default async (
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> => {
	res.setHeader('content-type', 'text/plain');
	res.end('hello world');
};
