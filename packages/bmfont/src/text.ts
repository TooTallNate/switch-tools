/**
 * Text and XML encodings of AngelCode BMFont descriptors, plus a
 * writer for the text encoding.
 *
 * Both encodings are a flat list of tags with `key=value` attributes:
 *
 *     info face="Arial" size=32 bold=0 italic=0 charset="" unicode=1 …
 *     common lineHeight=32 base=26 scaleW=256 scaleH=256 pages=1 packed=0 …
 *     page id=0 file="arial_0.png"
 *     chars count=95
 *     char id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=8 page=0 chnl=15
 *     kernings count=1
 *     kerning first=65 second=86 amount=-2
 *
 * The XML encoding has the same tags and attributes (`<info face="…" />`,
 * `<char id="32" … />`, nested in `<font>`, `<pages>`, `<chars>` and
 * `<kernings>`), so one attribute reader serves both.
 *
 * Source spec: https://www.angelcode.com/products/bmfont/doc/file_format.html
 */

import type {
	BmfChar,
	BmfCommon,
	BmfInfo,
	BmfKerning,
	ParsedBmFont,
} from './index.js';

interface Tag {
	name: string;
	attrs: Map<string, string>;
}

/** True when the bytes look like a text-encoded descriptor (`info …`). */
export function isBmfontText(bytes: Uint8Array): boolean {
	const head = decodeHead(bytes);
	return /^info\s/.test(head);
}

/** True when the bytes look like an XML-encoded descriptor. */
export function isBmfontXml(bytes: Uint8Array): boolean {
	const head = decodeHead(bytes);
	return head.startsWith('<') && /<font[\s>]/.test(decodeHead(bytes, 4096));
}

function decodeHead(bytes: Uint8Array, n = 256): string {
	let s = new TextDecoder('utf-8').decode(bytes.subarray(0, n));
	if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	return s.trimStart();
}

/** Parse a text-encoded descriptor (`.fnt` starting with `info`). */
export function parseBmfontText(input: string | Uint8Array): ParsedBmFont {
	const text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
	const tags: Tag[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*(\w+)(.*)$/.exec(line);
		if (!m) continue;
		const attrs = new Map<string, string>();
		const re = /(\w+)=("([^"]*)"|\S*)/g;
		let a: RegExpExecArray | null;
		while ((a = re.exec(m[2]!))) attrs.set(a[1]!, a[3] ?? a[2]!);
		tags.push({ name: m[1]!, attrs });
	}
	return fromTags(tags, 'text');
}

/** Parse an XML-encoded descriptor (`<font><info …/>…</font>`). */
export function parseBmfontXml(input: string | Uint8Array): ParsedBmFont {
	const text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
	const tags: Tag[] = [];
	const tagRe = /<(\w+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(text))) {
		const attrs = new Map<string, string>();
		const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
		let a: RegExpExecArray | null;
		while ((a = re.exec(m[2]!))) attrs.set(a[1]!, decodeEntities(a[2] ?? a[3]!));
		tags.push({ name: m[1]!, attrs });
	}
	return fromTags(tags, 'XML');
}

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
		const l = e.toLowerCase();
		if (l === 'amp') return '&';
		if (l === 'lt') return '<';
		if (l === 'gt') return '>';
		if (l === 'quot') return '"';
		if (l === 'apos') return "'";
		return String.fromCodePoint(l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
	});
}

function fromTags(tags: Tag[], encoding: string): ParsedBmFont {
	const num = (t: Tag, k: string, d = 0) => {
		const v = t.attrs.get(k);
		if (v === undefined || v === '') return d;
		const n = Number(v);
		return Number.isFinite(n) ? n : d;
	};
	const list = (t: Tag, k: string, n: number) => {
		const parts = (t.attrs.get(k) ?? '').split(',').map((s) => Number(s) || 0);
		return Array.from({ length: n }, (_, i) => parts[i] ?? 0);
	};

	let info: BmfInfo | null = null;
	let common: BmfCommon | null = null;
	const pages: string[] = [];
	const chars: BmfChar[] = [];
	const kernings: BmfKerning[] = [];

	for (const t of tags) {
		switch (t.name) {
			case 'info': {
				const [up, right, down, left] = list(t, 'padding', 4);
				const [horizontal, vertical] = list(t, 'spacing', 2);
				info = {
					fontSize: num(t, 'size'),
					flags: {
						smooth: num(t, 'smooth') !== 0,
						unicode: num(t, 'unicode') !== 0,
						italic: num(t, 'italic') !== 0,
						bold: num(t, 'bold') !== 0,
						fixedHeight: num(t, 'fixedHeight') !== 0,
					},
					charSet: num(t, 'charset'),
					stretchH: num(t, 'stretchH', 100),
					aa: num(t, 'aa', 1),
					padding: { up: up!, right: right!, down: down!, left: left! },
					spacing: { horizontal: horizontal!, vertical: vertical! },
					outline: num(t, 'outline'),
					face: t.attrs.get('face') ?? '',
				};
				break;
			}
			case 'common':
				common = {
					lineHeight: num(t, 'lineHeight'),
					base: num(t, 'base'),
					scaleW: num(t, 'scaleW'),
					scaleH: num(t, 'scaleH'),
					pages: num(t, 'pages', 1),
					flags: { packed: num(t, 'packed') !== 0 },
					alphaChnl: num(t, 'alphaChnl'),
					redChnl: num(t, 'redChnl'),
					greenChnl: num(t, 'greenChnl'),
					blueChnl: num(t, 'blueChnl'),
				};
				break;
			case 'page':
				pages[num(t, 'id', pages.length)] = t.attrs.get('file') ?? '';
				break;
			case 'char':
				chars.push({
					id: num(t, 'id'),
					x: num(t, 'x'),
					y: num(t, 'y'),
					width: num(t, 'width'),
					height: num(t, 'height'),
					xoffset: num(t, 'xoffset'),
					yoffset: num(t, 'yoffset'),
					xadvance: num(t, 'xadvance'),
					page: num(t, 'page'),
					chnl: num(t, 'chnl', 15),
				});
				break;
			case 'kerning':
				kernings.push({
					first: num(t, 'first'),
					second: num(t, 'second'),
					amount: num(t, 'amount'),
				});
				break;
		}
	}

	if (!common) throw new Error(`BMFont (${encoding}): missing "common" tag`);
	info ??= {
		fontSize: common.lineHeight,
		flags: { smooth: false, unicode: true, italic: false, bold: false, fixedHeight: false },
		charSet: 0,
		stretchH: 100,
		aa: 1,
		padding: { up: 0, right: 0, down: 0, left: 0 },
		spacing: { horizontal: 0, vertical: 0 },
		outline: 0,
		face: '',
	};
	for (let i = 0; i < Math.max(pages.length, common.pages); i++) {
		pages[i] ??= `page_${i}.png`;
	}
	return { version: 3, info, common, pages, chars, kernings };
}

/**
 * Write a descriptor in the text encoding, the one most tools and
 * engines read. Strings are quoted; a `"` in a face or page name
 * (which the format has no escape for) is replaced with `'`.
 */
export function writeBmfontText(font: ParsedBmFont): string {
	const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
	const b = (v: boolean) => (v ? 1 : 0);
	const { info, common } = font;
	const lines: string[] = [];
	lines.push(
		[
			'info',
			`face=${q(info.face)}`,
			`size=${info.fontSize}`,
			`bold=${b(info.flags.bold)}`,
			`italic=${b(info.flags.italic)}`,
			`charset=""`,
			`unicode=${b(info.flags.unicode)}`,
			`stretchH=${info.stretchH}`,
			`smooth=${b(info.flags.smooth)}`,
			`aa=${info.aa}`,
			`padding=${info.padding.up},${info.padding.right},${info.padding.down},${info.padding.left}`,
			`spacing=${info.spacing.horizontal},${info.spacing.vertical}`,
			`outline=${info.outline}`,
		].join(' '),
	);
	lines.push(
		[
			'common',
			`lineHeight=${common.lineHeight}`,
			`base=${common.base}`,
			`scaleW=${common.scaleW}`,
			`scaleH=${common.scaleH}`,
			`pages=${font.pages.length}`,
			`packed=${b(common.flags.packed)}`,
			`alphaChnl=${common.alphaChnl}`,
			`redChnl=${common.redChnl}`,
			`greenChnl=${common.greenChnl}`,
			`blueChnl=${common.blueChnl}`,
		].join(' '),
	);
	font.pages.forEach((file, id) => lines.push(`page id=${id} file=${q(file)}`));
	lines.push(`chars count=${font.chars.length}`);
	for (const c of font.chars) {
		lines.push(
			`char id=${c.id} x=${c.x} y=${c.y} width=${c.width} height=${c.height} xoffset=${c.xoffset} yoffset=${c.yoffset} xadvance=${c.xadvance} page=${c.page} chnl=${c.chnl}`,
		);
	}
	if (font.kernings.length) {
		lines.push(`kernings count=${font.kernings.length}`);
		for (const k of font.kernings) {
			lines.push(`kerning first=${k.first} second=${k.second} amount=${k.amount}`);
		}
	}
	return lines.join('\n') + '\n';
}
