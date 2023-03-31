import type { PixelCrop } from 'react-image-crop';
import type { ParsedFrame } from 'gifuct-js';
import type { MutableRefObject } from 'react';

export function renderGIF(
	frames: ParsedFrame[],
	canvas: HTMLCanvasElement,
	cropRef: MutableRefObject<PixelCrop | null>
) {
	const ctx = canvas.getContext('2d');

	// gif patch canvas
	const tempCanvas = document.createElement('canvas');
	const tempCtx = tempCanvas.getContext('2d')!;

	// full gif canvas
	const gifCanvas = document.createElement('canvas');
	const gifCtx = gifCanvas.getContext('2d')!;

	let playing = true;
	let frameIndex = 0;
	let needsDisposal = false;

	gifCanvas.width = frames[0].dims.width;
	gifCanvas.height = frames[0].dims.height;

	function renderFrame() {
		// get the frame
		var frame = frames[frameIndex];

		var start = new Date().getTime();

		if (needsDisposal) {
			gifCtx.clearRect(0, 0, gifCanvas.width, gifCanvas.height);
			needsDisposal = false;
		}

		// draw the patch
		drawPatch(frame);

		// update the frame index
		frameIndex++;
		if (frameIndex >= frames.length) {
			frameIndex = 0;
		}

		if (frame.disposalType === 2) {
			needsDisposal = true;
		}

		var end = new Date().getTime();
		var diff = end - start;

		if (playing) {
			// delay the next gif frame
			setTimeout(() => {
				requestAnimationFrame(renderFrame);
			}, Math.max(0, Math.floor(frame.delay - diff)));
		}
	}

	let frameImageData: ImageData | undefined;

	function drawPatch({ dims, patch }: ParsedFrame) {
		if (
			!frameImageData ||
			dims.width != frameImageData.width ||
			dims.height != frameImageData.height
		) {
			tempCanvas.width = dims.width;
			tempCanvas.height = dims.height;
			frameImageData = tempCtx.createImageData(dims.width, dims.height);
		}

		// set the patch data as an override
		frameImageData.data.set(patch);

		// draw the patch back over the canvas
		tempCtx.putImageData(frameImageData, 0, 0);

		gifCtx.drawImage(tempCanvas, dims.left, dims.top);

		const { current: crop } = cropRef;
		if (crop && ctx) {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(
				gifCanvas,
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
	}

	renderFrame();
}
