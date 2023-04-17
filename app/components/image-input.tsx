import bytes from 'bytes';
import { ChangeEventHandler, useEffect, useRef, useState } from 'react';
import ReactCrop, { Crop, PercentCrop, PixelCrop } from 'react-image-crop';
import * as Slider from '@radix-ui/react-slider';
import * as HoverCard from '@radix-ui/react-hover-card';

import { extractIcon, isNRO } from '~/lib/nro';
import { cropAndScaleGIF, getInfo, GifsicleOptions } from '~/gif.client';
import { FileInput, FileInputProps } from '~/components/file-input';

async function canvasPreview(
	image: HTMLImageElement,
	canvas: HTMLCanvasElement,
	crop: PixelCrop
) {
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new Error('No 2d context');
	}
	ctx.imageSmoothingEnabled = true;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(
		image,
		crop.x,
		crop.y,
		crop.width,
		crop.height,
		0,
		0,
		canvas.width,
		canvas.height
	);
}

export interface ImageInputProps extends FileInputProps {
	animated?: boolean;
	placeholder?: React.ReactNode;
	cropAspectRatio?: number;
	format: 'png' | 'jpeg' | 'gif';
	acceptNro?: boolean;
	onCroppedBlob: (blob: Blob) => void;
	onNRO?: (blob: Blob) => void;
}

export function ImageInput({
	animated,
	cropAspectRatio,
	placeholder,
	format,
	acceptNro,
	onCroppedBlob,
	onNRO,
	...props
}: ImageInputProps) {
	const [imgSrc, setImgSrc] = useState<string>();
	const [downloadHref, setDownloadHref] = useState<string>();
	const [downloadSize, setDownloadSize] = useState(0);
	const [crop, setCrop] = useState<Crop>();
	const [completedCrop, setCompletedCrop] = useState<PercentCrop>();
	const [generationTime, setGenerationTime] = useState(0);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const imgInputRef = useRef<HTMLInputElement | null>(null);
	const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const fileRef = useRef<File | null>(null);

	const [numberOfFrames, setNumberOfFrames] = useState(0);
	const [trim, setTrim] = useState<GifsicleOptions['trim']>();
	const [trimStart, setTrimStart] = useState(0);
	const [trimEnd, setTrimEnd] = useState(0);

	const toBlob = async (width: number, height: number, format: string) => {
		if (!imgRef.current || !completedCrop) return null;

		const pixelCrop: PixelCrop = {
			x: imgRef.current.naturalWidth * (completedCrop.x / 100),
			y: imgRef.current.naturalHeight * (completedCrop.y / 100),
			width: imgRef.current.naturalWidth * (completedCrop.width / 100),
			height: imgRef.current.naturalHeight * (completedCrop.height / 100),
			unit: 'px',
		};

		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;

		canvasPreview(imgRef.current, canvas, pixelCrop);

		const blob = await new Promise<Blob | null>((res) =>
			canvas.toBlob(res, `image/${format}`, 0.95)
		);
		return blob;
	};

	useEffect(() => {
		if (downloadHref) {
			return () => URL.revokeObjectURL(downloadHref);
		}
	}, [downloadHref]);

	useEffect(() => {
		if (imgSrc && fileRef.current) {
			// When a new image is selected, load it and set the initial crop
			const img = new Image();
			img.onload = () => {
				imgRef.current = img;
				let widthRatio = 1;
				let heightRatio = 1;
				if (cropAspectRatio) {
					if (cropAspectRatio > 1) {
						heightRatio /= cropAspectRatio;
					} else {
						widthRatio /= cropAspectRatio;
					}
				}
				const min = Math.min(
					img.naturalWidth / widthRatio,
					img.naturalHeight / heightRatio
				);
				const initialCrop: PercentCrop = {
					unit: '%',
					x: 0,
					y: 0,
					width: (min / img.naturalWidth) * 100 * widthRatio,
					height: (min / img.naturalHeight) * 100 * heightRatio,
				};
				setCrop(initialCrop);
				setCompletedCrop(initialCrop);
			};
			img.src = imgSrc;

			if (animated && fileRef.current.name.endsWith('.gif')) {
				getInfo(fileRef.current).then((info) => {
					const numFramesMatch = info.match(/(\d+) images/);
					if (numFramesMatch) {
						const numFrames = Number(numFramesMatch[1]);
						setNumberOfFrames(numFrames);
						setTrimStart(1);
						setTrimEnd(numFrames);
						setTrim({ start: 1, end: numFrames });
					}
				});
			}

			return () => {
				URL.revokeObjectURL(imgSrc);
			};
		}
	}, [imgSrc, fileRef, cropAspectRatio, animated]);

	useEffect(() => {
		if (completedCrop?.width && completedCrop?.height && imgRef.current) {
			const pixelCrop: PixelCrop = {
				x: imgRef.current.naturalWidth * (completedCrop.x / 100),
				y: imgRef.current.naturalHeight * (completedCrop.y / 100),
				width:
					imgRef.current.naturalWidth * (completedCrop.width / 100),
				height:
					imgRef.current.naturalHeight * (completedCrop.height / 100),
				unit: 'px',
			};
			const startTime = Date.now();
			if (animated && fileRef.current?.name.endsWith('.gif')) {
				cropAndScaleGIF(fileRef.current, {
					optimization: 3,
					lossy: 180,
					colors: 256,
					crop: pixelCrop,
					resize: { width: 256, height: 80 },
					trim,
				}).then((out) => {
					const diff = Date.now() - startTime;
					setDownloadHref(URL.createObjectURL(out));
					setDownloadSize(out.size);
					setGenerationTime(diff);
					onCroppedBlob(out);
				});
			} else if (previewCanvasRef.current) {
				canvasPreview(
					imgRef.current,
					previewCanvasRef.current,
					pixelCrop
				);
				const box = previewCanvasRef.current.getBoundingClientRect();
				toBlob(box.width, box.height, format).then((blob) => {
					if (blob) {
						const diff = Date.now() - startTime;
						setDownloadHref(URL.createObjectURL(blob));
						setDownloadSize(blob.size);
						setGenerationTime(diff);
						onCroppedBlob(blob);
					}
				});
			}
		}
	}, [completedCrop, animated, trim, fileRef, format]);

	useEffect(() => {
		if (imgInputRef.current && previewCanvasRef.current) {
			const { width, height } =
				imgInputRef.current.getBoundingClientRect();
			// Set width and height for HiDPI devices
			const dpr = window.devicePixelRatio || 1;
			previewCanvasRef.current.width = width * dpr;
			previewCanvasRef.current.height = height * dpr;
		}
	}, [imgInputRef.current, previewCanvasRef.current]);

	const handleImageChange: ChangeEventHandler<HTMLInputElement> = (e) => {
		const file = e.currentTarget.files?.[0];
		handleImageFile(file);
	};

	const handleImageFile = async (file?: File) => {
		fileRef.current = file || null;
		if (!file) {
			setImgSrc(undefined);
			setCrop(undefined);
			setCompletedCrop(undefined);
			return;
		}
		let image: Blob = file;
		if (await isNRO(file)) {
			onNRO?.(file);
			const icon = await extractIcon(file);
			image = new Blob([icon], { type: 'image/jpeg' });
		}
		const url = URL.createObjectURL(image);
		setImgSrc(url);
	};

	let accept = 'image/*';

	if (acceptNro) {
		accept += ',.nro';
	}

	const input = (
		<FileInput
			accept={accept}
			{...props}
			onChange={handleImageChange}
			ref={(ref) => {
				if (ref && ref !== imgInputRef.current) {
					imgInputRef.current = ref;
					handleImageFile(ref.files?.[0]);
				}
			}}
		>
			<div
				className="placeholder"
				style={{
					display: 'flex',
					justifyContent: 'center',
					alignItems: 'center',
					textAlign: 'center',
					position: 'absolute',
					top: 0,
					left: 0,
					width: '100%',
					height: '100%',
					pointerEvents: 'none',
					lineHeight: 1.5,
				}}
			>
				{placeholder}
			</div>
			{animated && fileRef.current?.name.endsWith('.gif') ? (
				<img src={downloadHref} />
			) : (
				<canvas
					ref={previewCanvasRef}
					style={{
						pointerEvents: 'none',
						width: '100%',
						height: '100%',
					}}
				/>
			)}
		</FileInput>
	);

	return (
		<HoverCard.Root>
			<HoverCard.Trigger asChild>{input}</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content className="HoverCardContent" sideOffset={5}>
					{imgSrc ? (
						<>
							<ReactCrop
								crop={crop}
								aspect={cropAspectRatio}
								onChange={(_, crop) => setCrop(crop)}
								onComplete={(_, crop) => setCompletedCrop(crop)}
							>
								<img
									ref={imgRef}
									src={imgSrc}
									style={{
										backgroundColor: 'black',
										maxWidth: '400px',
										maxHeight: '400px',
									}}
								/>
							</ReactCrop>
							{animated &&
							fileRef.current?.name.endsWith('.gif') ? (
								<>
									<div>
										Trim: ({trimStart}-{trimEnd})
										<Slider.Root
											className="SliderRoot"
											min={1}
											max={numberOfFrames}
											onValueChange={(v) => {
												setTrimStart(v[0]);
												setTrimEnd(v[1]);
											}}
											onValueCommit={(v) => {
												setTrim({
													start: v[0],
													end: v[1],
												});
											}}
											value={[trimStart, trimEnd]}
										>
											<Slider.Track className="SliderTrack">
												<Slider.Range className="SliderRange" />
											</Slider.Track>
											<Slider.Thumb className="SliderThumb" />
											<Slider.Thumb className="SliderThumb" />
										</Slider.Root>
									</div>
								</>
							) : null}
							<div>Size: {bytes(downloadSize)}</div>
							<a href={downloadHref} download>
								Download
							</a>
						</>
					) : (
						'No image selected…'
					)}
					<HoverCard.Arrow className="HoverCardArrow" />
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}
