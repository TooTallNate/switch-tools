import { Form, useLocation } from '@remix-run/react';
import { useCallback, useRef, useState } from 'react';
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
	const [logoType, setLogoType] = useState('2');
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
						<LogoTextSelect onValueChange={(v) => setLogoType(v)} />
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
				{advancedMode ? (
					<div className="Flex FlexThirds" style={{ gap: '20px' }}>
						<Input
							name="version"
							label="Version"
							tooltip="Version number which is displayed on the game's details"
							placeholder="1.0.0"
						/>
						<TitleIdInput />
					</div>
				) : null}
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
				<Input
					name="nroPath"
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
				{advancedMode ? (
					<div className="Flex Flex2Columns">
						<div className="Flex">
							<label
								className="Flex"
								style={{ userSelect: 'none' }}
							>
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
							<label
								className="Flex"
								style={{ userSelect: 'none' }}
							>
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
				) : null}
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
				{advancedMode ? (
					<>
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
						<input type="hidden" name="logoType" value={logoType} />
					</>
				) : null}
				<div
					className="Flex"
					style={{
						justifyContent: 'space-around',
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
