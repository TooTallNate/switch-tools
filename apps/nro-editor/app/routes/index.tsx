import { useEffect, useRef, useState } from 'react';
import { FileInput } from '@tootallnate/react-file-input';
import type { ChangeEventHandler } from 'react';
import type { LinksFunction } from '@vercel/remix';

import indexStyles from '~/styles/index.css';

export const links: LinksFunction = () => {
	return [{ rel: 'stylesheet', href: indexStyles }];
};

type Mode = 'initial' | 'editing';

export default function Index() {
	const [mode, setMode] = useState<Mode>('initial');
	const fileInputRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<File | null>(null);

	useEffect(() => {
		fileInputRef?.current?.focus();
	}, []);

	const handleFileSelected: ChangeEventHandler<HTMLInputElement> = (e) => {
		const [file] = e.currentTarget.files!;
		fileRef.current = file;
		setMode('editing');
	};

	return (
		<div className="editor">
			<div className="intro">
				Edit or view the icon, metadata, and RomFS files of a Nintendo
				Switch homebrew NRO file.
			</div>
			{mode === 'initial' ? (
				<FileInput
					onChange={handleFileSelected}
					accept=".nro"
					ref={fileInputRef}
					style={{ cursor: 'pointer' }}
				>
					<button>
						<div className="cursor"></div>
						<span>Click to select NRO file...</span>
					</button>
				</FileInput>
			) : (
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						width: '10em',
					}}
				>
					<button>
						<div className="cursor"></div>
						Icon
					</button>
					<button>
						<div className="cursor"></div>
						Metadata
					</button>
					<button>
						<div className="cursor"></div>
						RomFS
					</button>
				</div>
			)}
		</div>
	);
}
