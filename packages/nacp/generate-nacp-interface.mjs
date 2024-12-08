/**
 * node generate-nacp-interface.mjs /opt/devkitpro/libnx/include/switch/nacp.h > src/types.ts
 */
import camelCase from 'camelcase';
import { readFileSync } from 'node:fs';

const headerFile = readFileSync(
	process.argv[2] || '/opt/devkitpro/libnx/include/switch/nacp.h',
	'utf8'
);

const nacpStructMembersRegex =
	/typedef\s+struct\s*\{\s*((?:\s*(?:[\w\[\]]+\s+)+[\w\[\]]+\s*;.*\n?)*)\}\s*NacpStruct;/;

const nacpStructContents = headerFile.match(nacpStructMembersRegex);

console.log('export interface NacpStruct {');
console.log(
	nacpStructContents[1]
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const parts = line.split(/\s+/);
			const out = [`\t// ${parts.join(' ')}`];

			const type = parts[0];
			const name = parts[1].replace(/\;$/, '');
			if (/^[us]\d+$/.test(type) && !name.endsWith(']')) {
				const tsType = type.endsWith('64') ? 'bigint' : 'number';
				out.push(`\t${camelCase(name)}: ${tsType};`);
			}

			out.push('');
			return out;
		})
		.join('\n')
);
console.log('}');
