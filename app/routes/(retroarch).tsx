import { Form, useLocation } from '@remix-run/react';
import { useRef, useState } from 'react';
import { HeadersFunction, LinksFunction } from '@vercel/remix';

import { Input } from '~/components/input';
import { ImageInput } from '~/components/image-input';
import { PresetsDropdown } from '~/components/presets-dropdown';
import { KeysPlaceholder, KeysTooltip } from '~/components/keys-input';
import { LogoTextSelect } from '~/components/logo-text-select';
import { Nav } from '~/components/nav';

import cropStyles from 'react-image-crop/dist/ReactCrop.css';
import fontStyles from '~/styles/index.css';
import { TitleIdInput } from '~/components/title-id-input';
import * as Checkbox from '@radix-ui/react-checkbox';
import { CheckIcon } from '@radix-ui/react-icons';
import { generateNsp } from '~/lib/generate.client';
import { generateRandomID } from '~/lib/generate-id';
import clsx from 'clsx';
import { extractNACP } from '~/lib/nro';

export const headers: HeadersFunction = () => {
	return {
		'Cache-Control':
			'max-age: 600, s-maxage=3600, stale-while-revalidate=10',
	};
};

export const links: LinksFunction = () => {
	return [
		{ rel: 'stylesheet', href: cropStyles },
		{ rel: 'stylesheet', href: fontStyles },
	];
};

export default function Index() {
	const location = useLocation();
	const advancedMode = new URLSearchParams(location.search).has('advanced');
	const isRetroarch = location.pathname === '/retroarch';
	const [coreValue, setCoreValue] = useState('');
	const titleRef = useRef<HTMLInputElement | null>(null);
	const authorRef = useRef<HTMLInputElement | null>(null);
	const versionRef = useRef<HTMLInputElement | null>(null);
	const downloadLinkRef = useRef<HTMLAnchorElement | null>(null);
	const imageBlobRef = useRef<Blob | null>(null);
	const logoBlobRef = useRef<Blob | null>(null);
	const startupMovieBlobRef = useRef<Blob | null>(null);

	const handleSubmit: React.FormEventHandler<HTMLFormElement> = async (e) => {
		e.preventDefault();

		const formData = new FormData(e.currentTarget);

		const title = formData.get('title');
		if (typeof title !== 'string') {
			throw new Error('');
		}

		const publisher = formData.get('publisher');
		if (typeof publisher !== 'string') {
			throw new Error('');
		}

		const nroPath = formData.get('nroPath');
		if (typeof nroPath !== 'string') {
			throw new Error('');
		}

		const keys = formData.get('keys');
		if (!(keys instanceof File)) {
			throw new Error('`keys` is required');
		}

		let id = formData.get('id');
		if (typeof id !== 'string') {
			id = generateRandomID();
		}

		const version = formData.get('version');
		const startupUserAccount = formData.get('startupUserAccount');
		const screenshot = formData.get('screenshot');
		const logoType = formData.get('logoType');
		const romPath = formData.get('romPath');

		if (!imageBlobRef.current) {
			throw new Error('`image` is required');
		}

		const nsp = await generateNsp({
			id,
			keys,
			image: imageBlobRef.current,
			title,
			publisher,
			nroPath,

			version: typeof version === 'string' ? version : undefined,
			startupUserAccount:
				typeof startupUserAccount === 'string'
					? startupUserAccount === 'on'
					: undefined,
			screenshot:
				typeof screenshot === 'string'
					? screenshot === 'on'
					: undefined,
			logoType:
				typeof logoType === 'string' && logoType.length > 0
					? Number(logoType)
					: undefined,
			romPath: typeof romPath === 'string' ? romPath : undefined,
			logo: logoBlobRef.current || undefined,
			startupMovie: startupMovieBlobRef.current || undefined,
		});

		const a = downloadLinkRef.current;
		if (a) {
			const url = URL.createObjectURL(nsp);
			a.href = url;
			a.download = `${title} [${id}].nsp`;
			a.click();

			// To make this work on Firefox we need to wait
			// a little while before removing it.
			setTimeout(() => {
				URL.revokeObjectURL(url);
				a.removeAttribute('href');
				a.removeAttribute('download');
			}, 0);
		}
	};

	async function handleNroSelected(blob: Blob) {
		const nacp = await extractNACP(blob);
		if (titleRef.current) {
			titleRef.current.value = nacp.title;
		}
		if (authorRef.current) {
			authorRef.current.value = nacp.author;
		}
		if (versionRef.current) {
			versionRef.current.value = nacp.version;
		}
	}

	return (
		<>
			<Nav advancedMode={advancedMode} />
			<Form onSubmit={handleSubmit} style={{ width: '100%' }}>
				<ImageInput
					required
					acceptNro={!isRetroarch}
					name="image"
					className="Input image-input"
					placeholder={
						isRetroarch ? (
							<>
								Click to select game
								<br />
								box art image file…
							</>
						) : (
							<>
								Click to select
								<br />
								NRO or image file…
							</>
						)
					}
					cropAspectRatio={1}
					format="jpeg"
					onCroppedBlob={(blob) => (imageBlobRef.current = blob)}
					onNRO={handleNroSelected}
					style={{
						lineHeight: 0,
						width: '256px',
						height: '256px',
					}}
				/>
				<div className={clsx('boot-up', !advancedMode && 'hidden')}>
					<div className="logo-controls">
						<LogoTextSelect name="logoType" />
						<ImageInput
							name="logo"
							className="Input image-input"
							placeholder="Select logo…"
							cropAspectRatio={160 / 40}
							format="png"
							onCroppedBlob={(blob) =>
								(logoBlobRef.current = blob)
							}
							style={{
								lineHeight: 0,
								margin: '0',
								width: '160px',
								height: '40px',
								flex: '0 0 auto',
							}}
						/>
					</div>
					<div>
						<ImageInput
							animated
							name="animation"
							className="Input image-input"
							placeholder="Select startup animation…"
							cropAspectRatio={256 / 80}
							format="gif"
							onCroppedBlob={(blob) =>
								(startupMovieBlobRef.current = blob)
							}
							style={{
								lineHeight: 0,
								margin: '0',
								width: '256px',
								height: '80px',
								flex: '0 0 auto',
							}}
						/>
					</div>
				</div>
				<div
					className={clsx(
						'Flex',
						'FlexThirds',
						!advancedMode && 'hidden'
					)}
					style={{ gap: '20px' }}
				>
					<Input
						ref={versionRef}
						name="version"
						label="Version"
						tooltip="Version number which is displayed on the game's details"
						placeholder="1.0.0"
					/>
					<TitleIdInput />
				</div>
				<Input
					ref={titleRef}
					name="title"
					required
					label={`${isRetroarch ? 'Game' : 'App'} Title`}
					tooltip="Name displyed on the Nintendo Switch home screen"
					placeholder={
						isRetroarch ? 'Super Mario World' : 'HB App Store'
					}
				/>
				<Input
					ref={authorRef}
					name="publisher"
					required
					label="Publisher"
					tooltip="Name of the publisher displayed on the game's details"
					placeholder={isRetroarch ? 'Nintendo' : '4TU Team'}
				/>
				<Input
					name="nroPath"
					required
					label={`${isRetroarch ? 'Core' : 'NRO'} Path`}
					tooltip={`File path to the ${
						isRetroarch ? 'RetroArch core' : 'homebrew application'
					} NRO file on the Nintendo Switch SD card`}
					placeholder={
						isRetroarch
							? '/retroarch/cores/snes9x_libretro_libnx.nro'
							: '/switch/appstore/appstore.nro'
					}
					value={coreValue}
					onInput={(e) => {
						setCoreValue(e.currentTarget.value);
					}}
				>
					{isRetroarch ? (
						<PresetsDropdown
							value={coreValue}
							onSelect={(v) => setCoreValue(v)}
						/>
					) : null}
				</Input>
				{isRetroarch ? (
					<Input
						required
						name="romPath"
						label="ROM Path"
						tooltip="File path to the game ROM file on the Nintendo Switch SD card"
						placeholder="/ROMs/SNES/Super Mario World.smc"
					/>
				) : null}
				<Input
					id="keys"
					name="keys"
					type="file"
					required
					label="Prod Keys"
					accept=".keys,.dat,text/*"
					tooltip={<KeysTooltip />}
					placeholder={<KeysPlaceholder />}
				/>
				<div
					className={clsx(
						'Flex',
						'Flex2Columns',
						!advancedMode && 'hidden'
					)}
				>
					<div className="Flex">
						<label className="Flex" style={{ userSelect: 'none' }}>
							<Checkbox.Root
								className="CheckboxRoot"
								name="screenshot"
								defaultChecked={true}
							>
								<Checkbox.Indicator className="CheckboxIndicator">
									<CheckIcon />
								</Checkbox.Indicator>
							</Checkbox.Root>
							Enable screenshots
						</label>
					</div>
					<div className="Flex">
						<label className="Flex" style={{ userSelect: 'none' }}>
							<Checkbox.Root
								className="CheckboxRoot"
								name="startupUserAccount"
							>
								<Checkbox.Indicator className="CheckboxIndicator">
									<CheckIcon />
								</Checkbox.Indicator>
							</Checkbox.Root>
							Enable profile selector
						</label>
					</div>
				</div>
				<div className="Flex">
					<button type="submit" className="Button">
						Generate NSP
					</button>
					<a ref={downloadLinkRef} style={{ display: 'none' }}></a>
				</div>
			</Form>
		</>
	);
}
