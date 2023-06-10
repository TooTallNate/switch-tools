import { useEffect, useRef } from 'react';
import { FileInput } from '@tootallnate/react-file-input';
import type { ChangeEventHandler } from 'react';
import type { LinksFunction } from '@vercel/remix';

import indexStyles from '~/styles/index.css';

export const links: LinksFunction = () => {
	return [{ rel: 'stylesheet', href: indexStyles }];
};

export default function Index() {
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		fileInputRef?.current?.focus();
	}, []);

	const handleFileSelected: ChangeEventHandler<HTMLInputElement> = (e) => {
		const [file] = e.currentTarget.files!;
		console.log(file);
	};

	return (
		<div className="editor">
			<p className="intro">
				Edit or view the icon, metadata, and RomFS files of a Nintendo
				Switch homebrew <code>.nro</code> file.
			</p>
			<FileInput
				onChange={handleFileSelected}
				accept=".nro"
				ref={fileInputRef}
				style={{ cursor: 'pointer' }}
			>
				<button>
					<div className="cursor"></div>
					<span>
						Select <code>nro</code> file
					</span>
				</button>
			</FileInput>
		</div>
	);
}
