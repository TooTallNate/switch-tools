import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, copy, writeFile, readdir, remove, readFile } from 'fs-extra';
import { spawn } from 'child_process';
import { IncomingMessage, ServerResponse } from 'http';
import { once } from 'events';

const TEMPLATE_PATH = join(__dirname, '../template');
const HACBREWPACK_PATH = join(__dirname, '../hacbrewpack');

export default async (
	_req: IncomingMessage,
	res: ServerResponse
): Promise<void> => {
	const parts: Buffer[] = [];
	for await (const part of _req) {
		parts.push(part);
	}
	const body = Buffer.concat(parts);
	const host = _req.headers['x-forwarded-host'] || _req.headers['host'];
	const protocol = _req.headers['x-forwarded-proto'] || 'https';
	const url = new URL(_req.url || '/', `${protocol}://${host}`);
	const req = new Request(url.href, {
		headers: {
			'content-type': _req.headers['content-type']!,
		},
		method: _req.method,
		body,
	});
	res.setHeader('content-type', 'text/plain');
	const formData = await req.formData();
	const title = formData.get('title');
	const publisher = formData.get('publisher');
	const core = formData.get('core');
	const rom = formData.get('rom');
	const imageFile = formData.get('image');
	const keysFile = formData.get('keys');
	//console.log({
	//	title,
	//	publisher,
	//	core,
	//	rom,
	//	image: imageFile,
	//	keys: keysFile,
	//});
	if (!imageFile || typeof imageFile === 'string') {
		throw new Error('expected "image" to be a File');
	}
	if (!keysFile || typeof keysFile === 'string') {
		throw new Error('expected "keys" to be a File');
	}

	const cwd = await mkdtemp(join(tmpdir(), `nsp-`));
	try {
		await copy(TEMPLATE_PATH, cwd);

		await Promise.all([
			writeFile(
				join(cwd, 'keys.dat'),
				Buffer.from(await keysFile.arrayBuffer())
			),
			writeFile(join(cwd, 'romfs/nextNroPath'), `sdmc:${core}`),
			writeFile(
				join(cwd, 'romfs/nextArgv'),
				`sdmc:${core} "sdmc:${rom}"`
			),
			writeFile(
				join(cwd, 'control/icon_AmericanEnglish.dat'),
				Buffer.from(await imageFile.arrayBuffer())
			),
		]);

		const proc = spawn(
			HACBREWPACK_PATH,
			[
				'--titleid',
				'05D4B8D48CB70000',
				'--titlename',
				title as string,
				'--titlepublisher',
				publisher as string,
			],
			{ cwd }
		);
		//proc.stderr.pipe(res, { end: false });
		//proc.stdout.pipe(res, { end: false });
		await once(proc, 'close');
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="filename.nsp"`
		);
		res.end(
			await readFile(join(cwd, 'hacbrewpack_nsp/05d4b8d48cb70000.nsp'))
		);
	} finally {
		await remove(cwd);
	}
};
