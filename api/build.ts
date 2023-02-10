import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, copy, writeFile, remove, readFile } from 'fs-extra';
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
	const host = _req.headers['x-forwarded-host'] || _req.headers['host'];
	const protocol = _req.headers['x-forwarded-proto'] || 'https';
	const url = new URL(_req.url || '/', `${protocol}://${host}`);
	const req = new Request(url.href, {
		headers: {
			'content-type': _req.headers['content-type']!,
		},
		method: _req.method,
		body: Buffer.concat(parts),
	});
	res.setHeader('content-type', 'text/plain');
	const formData = await req.formData();
	const id = formData.get('id');
	const title = formData.get('title');
	const publisher = formData.get('publisher');
	const core = formData.get('core');
	const rom = formData.get('rom');
	const imageFile = formData.get('image');
	const keysFile = formData.get('keys');
	const cwd = await mkdtemp(join(tmpdir(), `nsp-`));
	try {
        if (typeof id !== 'string') {
            throw new BadRequest('expected "id" to be a string');
        }
        if (typeof title !== 'string') {
            throw new BadRequest('expected "title" to be a string');
        }
        if (typeof publisher !== 'string') {
            throw new BadRequest('expected "publisher" to be a string');
        }
        if (typeof core !== 'string') {
            throw new BadRequest('expected "core" to be a string');
        }
        if (typeof rom !== 'string') {
            throw new BadRequest('expected "rom" to be a string');
        }
        if (!imageFile || typeof imageFile === 'string') {
            throw new BadRequest('expected "image" to be a File');
        }
        if (!keysFile || typeof keysFile === 'string') {
            throw new BadRequest('expected "keys" to be a File');
        }

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
                id,
				'--titlename',
				title,
				'--titlepublisher',
				publisher,
			],
			{ cwd }
		);
		//proc.stderr.pipe(res, { end: false });
		//proc.stdout.pipe(res, { end: false });
		await once(proc, 'close');
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="${title} [${id}].nsp"`
		);
		res.end(
			await readFile(join(cwd, `hacbrewpack_nsp/${id}.nsp`))
		);
	} catch(err: any) {
        res.setHeader('Content-Type', 'application/json; charset=utf8');
        res.statusCode = err.code || 500;
        res.end(JSON.stringify({ error: err.message }));
	} finally {
		await remove(cwd);
	}
};

class BadRequest extends Error {
    code = 400;
}