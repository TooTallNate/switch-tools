import bytes from 'bytes';
import { ChangeEventHandler, useEffect, useRef, useState } from 'react';
import ReactCrop, { Crop, PercentCrop, PixelCrop } from 'react-image-crop';
import { Slider } from '~/components/ui/slider';
import {
	HoverCard,
	HoverCardTrigger,
	HoverCardContent,
} from '~/components/ui/hover-card';
import { extractIcon, isNRO } from '@tootallnate/nro';
import { cn } from '~/lib/utils';

import { cropAndScaleGIF, getInfo, GifsicleOptions } from '~/gif.client';

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
	ctx.imageSmoothingQuality = 'high';
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

export interface ImageInputProps
	extends Omit<React.ComponentPropsWithoutRef<'input'>, 'placeholder'> {
	animated?: boolean;
	placeholder?: React.ReactNode;
	cropAspectRatio?: number;
	format: 'png' | 'jpeg' | 'gif';
	/** Maximum output blob size in bytes. If the initial output exceeds this,
	 *  the JPEG quality will be iteratively reduced until it fits. */
	maxSize?: number;
	acceptNro?: boolean;
	onCroppedBlob: (blob: Blob) => void;
	onNRO?: (blob: Blob) => void;
}

export function ImageInput({
	animated,
	cropAspectRatio,
	placeholder,
	format,
	maxSize,
	acceptNro,
	onCroppedBlob,
	onNRO,
	className,
	style,
	onChange,
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
	const labelRef = useRef<HTMLLabelElement | null>(null);

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

		// If a maxSize is set, iteratively reduce JPEG quality until the
		// output fits. This is necessary because Atmosphère shows a "?"
		// icon on the home screen when the icon exceeds 0x20000 bytes.
		console.log(
			`Generating ${format} image: ${width}x${height}, maxSize=${
				maxSize ?? 'none'
			}`
		);
		let quality = 1.0;
		while (quality > 0) {
			const blob = await new Promise<Blob | null>((res) =>
				canvas.toBlob(res, `image/${format}`, quality)
			);
			if (!blob) return null;
			console.log(
				`image/${format} quality=${Math.round(quality * 100)}%: ${
					blob.size
				} bytes`
			);
			if (!maxSize || blob.size <= maxSize) {
				return blob;
			}
			console.log(
				`Image exceeds maxSize (${blob.size} > ${maxSize}), reducing quality...`
			);
			quality -= 0.02;
		}
		// Quality exhausted — return whatever we get at minimum quality
		console.warn(
			'Image quality exhausted — returning minimum quality image'
		);
		const blob = await new Promise<Blob | null>((res) =>
			canvas.toBlob(res, `image/${format}`, 0.01)
		);
		if (blob) {
			console.log(`Final image/${format} size: ${blob.size} bytes`);
		}
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
		if (labelRef.current && previewCanvasRef.current) {
			const { width, height } = labelRef.current.getBoundingClientRect();
			// Set width and height for HiDPI devices
			const dpr = window.devicePixelRatio || 1;
			previewCanvasRef.current.width = width * dpr;
			previewCanvasRef.current.height = height * dpr;
		}
	}, [labelRef.current, previewCanvasRef.current]);

	const handleImageChange: ChangeEventHandler<HTMLInputElement> = (e) => {
		onChange?.(e);
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
		let image: Blob | null = file;
		if (await isNRO(file)) {
			onNRO?.(file);
			const icon = await extractIcon(file);
			image = icon ? new Blob([icon], { type: 'image/jpeg' }) : null;
		}
		if (image) {
			const url = URL.createObjectURL(image);
			setImgSrc(url);
		}
	};

	let accept = 'image/*';

	if (acceptNro) {
		accept += ',.nro';
	}

	const input = (
		<label
			ref={labelRef}
			className={cn(
				'relative flex cursor-pointer items-center justify-center overflow-hidden rounded-md border border-input p-0 shadow-xs',
				'dark:bg-input/30',
				className
			)}
			style={style}
		>
			<input
				type="file"
				className="absolute inset-0 size-full cursor-inherit opacity-0"
				accept={accept}
				{...props}
				onChange={handleImageChange}
				ref={(ref) => {
					if (ref && ref !== imgInputRef.current) {
						imgInputRef.current = ref;
						handleImageFile(ref.files?.[0]);
					}
				}}
			/>
			<div
				className={cn(
					'pointer-events-none absolute inset-0 flex items-center justify-center text-center leading-relaxed',
					imgSrc && 'opacity-0'
				)}
			>
				{placeholder}
			</div>
			{animated && fileRef.current?.name.endsWith('.gif') ? (
				<img src={downloadHref} />
			) : (
				<canvas
					ref={previewCanvasRef}
					className="pointer-events-none size-full"
				/>
			)}
		</label>
	);

	return (
		<HoverCard>
			<HoverCardTrigger asChild>{input}</HoverCardTrigger>
			<HoverCardContent
				className="flex w-auto max-w-[450px] flex-col items-center gap-2"
				sideOffset={5}
			>
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
								className="max-h-[400px] max-w-[400px] bg-black"
							/>
						</ReactCrop>
						{animated && fileRef.current?.name.endsWith('.gif') ? (
							<>
								<div className="flex w-full flex-col gap-2 text-sm">
									Trim: ({trimStart}-{trimEnd})
									<Slider
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
										className="w-[200px]"
									/>
								</div>
							</>
						) : null}
						<div className="text-sm">
							Size: {bytes(downloadSize)}
						</div>
						<a
							href={downloadHref}
							download
							className="text-sm text-primary underline"
						>
							Download
						</a>
					</>
				) : (
					'No image selected…'
				)}
			</HoverCardContent>
		</HoverCard>
	);
}
