import cookie from 'cookie';
import { Form, useLoaderData } from '@remix-run/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
	HeadersFunction,
	json,
	LinksFunction,
	LoaderArgs,
} from '@vercel/remix';

import { Input } from '~/components/input';
import { ImageInput } from '~/components/image-input';
import { PresetsDropdown } from '~/components/presets-dropdown';
import { KeysPlaceholder, KeysTooltip } from '~/components/keys-input';
import { LogoTextSelect } from '~/components/logo-text-select';
import { Nav } from '~/components/nav';

import cropStyles from 'react-image-crop/dist/ReactCrop.css';
import radixWhiteA from '@radix-ui/colors/whiteA.css';
import radixBlackA from '@radix-ui/colors/blackA.css';
import radixMauve from '@radix-ui/colors/mauveDark.css';
import radixViolet from '@radix-ui/colors/violetDark.css';
import fontStyles from '~/styles/index.css';

export const config = { runtime: 'edge' };

export const headers: HeadersFunction = () => {
	return {
		'Cache-Control': 'max-age: 600, s-maxage=3600, stale-while-revalidate=10',
	};
};

export const links: LinksFunction = () => {
	return [
		{ rel: 'stylesheet', href: cropStyles },
		{ rel: 'stylesheet', href: radixWhiteA },
		{ rel: 'stylesheet', href: radixBlackA },
		{ rel: 'stylesheet', href: radixMauve },
		{ rel: 'stylesheet', href: radixViolet },
		{ rel: 'stylesheet', href: fontStyles },
	];
};

interface FormState {
	mode: 'normal' | 'retroarch';
	advancedMode: boolean;
}

export async function loader({ request }: LoaderArgs) {
	const url = new URL(request.url);
	let formState: FormState = {
		mode: url.pathname === '/retroarch' ? 'retroarch' : 'normal',
		advancedMode: url.searchParams.has('advanced'),
	};
	//try {
	//	const cookies = cookie.parse(request.headers.get('Cookie') ?? '');
	//	cookies['nsp-form-state']
	//} catch {
	//}
	return json(formState);
}

export default function Index() {
	const { mode, advancedMode } = useLoaderData<typeof loader>();
	const isRetroarch = mode === 'retroarch';
	const [coreValue, setCoreValue] = useState('');
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const logoInputRef = useRef<HTMLInputElement | null>(null);
	const startupMovieInputRef = useRef<HTMLInputElement | null>(null);

	const handleImageCropBlob = useCallback(
		(blob: Blob) => {
			if (imageInputRef.current) {
				const file = new File([blob], 'image');
				const container = new DataTransfer();
				container.items.add(file);
				imageInputRef.current.files = container.files;
			}
		},
		[imageInputRef]
	);

	const handleLogoCropBlob = useCallback(
		(blob: Blob) => {
			if (logoInputRef.current) {
				const file = new File([blob], 'logo');
				const container = new DataTransfer();
				container.items.add(file);
				logoInputRef.current.files = container.files;
			}
		},
		[logoInputRef]
	);

	const handleStartupMovieCropBlob = useCallback(
		(blob: Blob) => {
			if (startupMovieInputRef.current) {
				const file = new File([blob], 'startupMovie');
				const container = new DataTransfer();
				container.items.add(file);
				startupMovieInputRef.current.files = container.files;
			}
		},
		[logoInputRef]
	);

	return (
		<>
			<Nav advancedMode={advancedMode} />
			<ImageInput
				name="image"
				className="Input image-input"
				placeholder="Click to select image…"
				cropAspectRatio={1}
				onCropBlob={handleImageCropBlob}
				style={{
					lineHeight: 0,
					width: '256px',
					height: '256px',
				}}
			/>
			{advancedMode ? (
				<div className="boot-up">
					<div className="logo-controls">
						<LogoTextSelect />
						<ImageInput
							name="logo"
							className="Input image-input"
							placeholder="Select logo…"
							cropAspectRatio={160 / 40}
							onCropBlob={handleLogoCropBlob}
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
							onCropBlob={handleStartupMovieCropBlob}
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
			) : null}
			<Form
				method="post"
				action="/generate"
				encType="multipart/form-data"
				reloadDocument
				style={{ width: '100%' }}
			>
				<Input
					name="title"
					required
					label={`${isRetroarch ? 'Game' : 'App'} Title`}
					tooltip="Name displyed on the Nintendo Switch home screen"
					placeholder={
						isRetroarch ? 'Super Mario World' : 'HB App Store'
					}
				/>
				<Input
					name="publisher"
					required
					label="Publisher"
					tooltip="Name of the publisher displayed on the game's details"
					placeholder={isRetroarch ? 'Nintendo' : '4TU Team'}
				/>
				{advancedMode ? (
					<>
						<Input
							name="version"
							label="Version"
							tooltip="Version number which is displayed on the game's details"
							placeholder="1.0.0"
						/>
					</>
				) : null}
				<Input
					name="core"
					required
					label={`${isRetroarch ? 'Core' : 'NRO'} Path`}
					tooltip={`File path to the ${
						isRetroarch
							? 'RetroArch core'
							: 'homebrew application NRO'
					} file on the Nintendo Switch SD card`}
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
						name="rom"
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
				<input
					type="file"
					name="image"
					ref={imageInputRef}
					required
					style={{
						opacity: 0,
						position: 'absolute',
						width: 0,
						height: 0,
					}}
				/>
				<input
					type="file"
					name="logo"
					ref={logoInputRef}
					style={{
						opacity: 0,
						position: 'absolute',
						width: 0,
						height: 0,
					}}
				/>
				<input
					type="file"
					name="startupMovie"
					ref={startupMovieInputRef}
					style={{
						opacity: 0,
						position: 'absolute',
						width: 0,
						height: 0,
					}}
				/>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-around',
						width: '100%',
					}}
				>
					<button type="submit" className="Button">
						Generate NSP
					</button>
				</div>
			</Form>
		</>
	);
}
