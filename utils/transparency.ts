import type { TransparencyOptions } from '../types';

type LabTuple = [number, number, number];
type RGBTuple = [number, number, number];

const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Image failed to load'));
        image.src = src;
    });

const srgbToLinear = (value: number) =>
    value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

const rgbToLab = (r: number, g: number, b: number): LabTuple => {
    const R = srgbToLinear(r / 255);
    const G = srgbToLinear(g / 255);
    const B = srgbToLinear(b / 255);

    const X = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B;
    const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
    const Z = 0.0193339 * R + 0.119192 * G + 0.9503041 * B;
    const xn = 0.95047;
    const yn = 1.0;
    const zn = 1.08883;

    const fx = labF(X / xn);
    const fy = labF(Y / yn);
    const fz = labF(Z / zn);

    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

const distLab = (l: number, a: number, b: number, ref: LabTuple) => {
    const dL = l - ref[0];
    const dA = a - ref[1];
    const dB = b - ref[2];
    return Math.sqrt(dL * dL + dA * dA + dB * dB);
};

const medianColor = (samples: RGBTuple[]): RGBTuple => {
    const rs = samples.map((p) => p[0]).sort((a, b) => a - b);
    const gs = samples.map((p) => p[1]).sort((a, b) => a - b);
    const bs = samples.map((p) => p[2]).sort((a, b) => a - b);
    return [
        rs[(rs.length / 2) | 0],
        gs[(gs.length / 2) | 0],
        bs[(bs.length / 2) | 0],
    ];
};

const pickPatch = (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    x0: number,
    y0: number,
    size = 24,
): RGBTuple[] => {
    const colors: RGBTuple[] = [];
    const xEnd = Math.min(width, x0 + size);
    const yEnd = Math.min(height, y0 + size);
    for (let y = y0; y < yEnd; y++) {
        for (let x = x0; x < xEnd; x++) {
            const offset = (y * width + x) * 4;
            colors.push([data[offset], data[offset + 1], data[offset + 2]]);
        }
    }
    return colors;
};

const applyFeather = (mask: Float32Array, width: number, height: number, radius: number) => {
    if (radius <= 0) {
        return;
    }
    const tmp = new Float32Array(mask.length);
    const windowSize = radius * 2 + 1;

    // Horizontal pass
    for (let y = 0; y < height; y++) {
        const rowOffset = y * width;
        for (let x = 0; x < width; x++) {
            const start = Math.max(0, x - radius);
            const end = Math.min(width - 1, x + radius);
            let sum = 0;
            for (let xi = start; xi <= end; xi++) {
                sum += mask[rowOffset + xi];
            }
            tmp[rowOffset + x] = sum / (end - start + 1);
        }
    }

    // Vertical pass (writes back into mask)
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const start = Math.max(0, y - radius);
            const end = Math.min(height - 1, y + radius);
            let sum = 0;
            for (let yi = start; yi <= end; yi++) {
                sum += tmp[yi * width + x];
            }
            mask[y * width + x] = sum / (end - start + 1);
        }
    }
};

export const makeBackgroundTransparent = async (
    imageUrl: string,
    opts: Partial<TransparencyOptions> = {},
): Promise<string> => {
    const {
        colorTol = 10,
        tileGuess = 16,
        gradKeep = 10,
        feather = 2,
    } = opts;

    try {
        const img = await loadImage(imageUrl);

        const canvas = document.createElement('canvas');
        const width = (canvas.width = img.width);
        const height = (canvas.height = img.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
            throw new Error('Could not get canvas context');
        }
        ctx.drawImage(img, 0, 0);

        const imgData = ctx.getImageData(0, 0, width, height);
        const data = imgData.data;
        const totalPixels = width * height;

        const labL = new Float32Array(totalPixels);
        const labA = new Float32Array(totalPixels);
        const labB = new Float32Array(totalPixels);
        const luminance = new Float32Array(totalPixels);

        for (let pixel = 0, offset = 0; pixel < totalPixels; pixel++, offset += 4) {
            const r = data[offset];
            const g = data[offset + 1];
            const b = data[offset + 2];
            const [L, A, B] = rgbToLab(r, g, b);
            labL[pixel] = L;
            labA[pixel] = A;
            labB[pixel] = B;
            luminance[pixel] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }

        const cornerSamples = [
            ...pickPatch(data, width, height, 0, 0),
            ...pickPatch(data, width, height, Math.max(0, width - 24), 0),
            ...pickPatch(data, width, height, 0, Math.max(0, height - 24)),
            ...pickPatch(data, width, height, Math.max(0, width - 24), Math.max(0, height - 24)),
        ];

        const lightSamples: RGBTuple[] = [];
        const darkSamples: RGBTuple[] = [];

        const cornerLs = cornerSamples.map(([r, g, b]) => rgbToLab(r, g, b)[0]);
        const sortedL = [...cornerLs].sort((a, b) => a - b);
        const medianL = sortedL[(sortedL.length / 2) | 0];

        cornerSamples.forEach((rgb, index) => {
            if (cornerLs[index] >= medianL) {
                lightSamples.push(rgb);
            } else {
                darkSamples.push(rgb);
            }
        });

        const c1 = medianColor(lightSamples.length ? lightSamples : cornerSamples);
        const c2 = medianColor(darkSamples.length ? darkSamples : cornerSamples);
        const c1Lab = rgbToLab(c1[0], c1[1], c1[2]);
        const c2Lab = rgbToLab(c2[0], c2[1], c2[2]);

        const scorePeriod = (period: number) => {
            let score = 0;
            const step = Math.max(1, Math.floor(width / 64));
            for (let y = 0; y < height; y += step) {
                const rowOffset = y * width;
                for (let x = 0; x < width; x += step) {
                    const index = rowOffset + x;
                    const parity = (Math.floor(x / period) + Math.floor(y / period)) & 1;
                    const dc1 = distLab(labL[index], labA[index], labB[index], c1Lab);
                    const dc2 = distLab(labL[index], labA[index], labB[index], c2Lab);
                    const match = parity ? dc2 < dc1 : dc1 < dc2;
                    if (Math.min(dc1, dc2) < colorTol && match) {
                        score++;
                    }
                }
            }
            return score;
        };

        let bestPeriod = tileGuess;
        let bestScore = -1;
        for (let period = Math.max(8, tileGuess - 6); period <= tileGuess + 6; period++) {
            const score = scorePeriod(period);
            if (score > bestScore) {
                bestScore = score;
                bestPeriod = period;
            }
        }

        const grad = new Float32Array(totalPixels);
        for (let y = 1; y < height - 1; y++) {
            const row = y * width;
            for (let x = 1; x < width - 1; x++) {
                const idx = row + x;
                const lum = (yy: number, xx: number) => luminance[yy * width + xx];
                const gx =
                    -lum(y - 1, x - 1) -
                    2 * lum(y, x - 1) -
                    lum(y + 1, x - 1) +
                    lum(y - 1, x + 1) +
                    2 * lum(y, x + 1) +
                    lum(y + 1, x + 1);
                const gy =
                    -lum(y - 1, x - 1) -
                    2 * lum(y - 1, x) -
                    lum(y - 1, x + 1) +
                    lum(y + 1, x - 1) +
                    2 * lum(y + 1, x) +
                    lum(y + 1, x + 1);
                grad[idx] = Math.hypot(gx, gy) / 8;
            }
        }

        const like = new Float32Array(totalPixels);
        for (let y = 0; y < height; y++) {
            const rowOffset = y * width;
            for (let x = 0; x < width; x++) {
                const index = rowOffset + x;
                const parity = (Math.floor(x / bestPeriod) + Math.floor(y / bestPeriod)) & 1;
                const dc1 = distLab(labL[index], labA[index], labB[index], c1Lab);
                const dc2 = distLab(labL[index], labA[index], labB[index], c2Lab);
                const dc = parity ? dc2 : dc1;
                let likelihood = Math.max(0, 1 - dc / colorTol);
                if (grad[index] > gradKeep) {
                    likelihood *= 0.2;
                }
                like[index] = likelihood;
            }
        }

        const queueX = new Int32Array(totalPixels);
        const queueY = new Int32Array(totalPixels);
        const seen = new Uint8Array(totalPixels);
        let head = 0;
        let tail = 0;

        const enqueue = (x: number, y: number) => {
            const idx = y * width + x;
            if (seen[idx]) {
                return;
            }
            seen[idx] = 1;
            queueX[tail] = x;
            queueY[tail] = y;
            tail++;
        };

        for (let x = 0; x < width; x++) {
            if (like[x] > 0.5) enqueue(x, 0);
            const bottom = (height - 1) * width + x;
            if (like[bottom] > 0.5) enqueue(x, height - 1);
        }
        for (let y = 0; y < height; y++) {
            const leftIndex = y * width;
            const rightIndex = y * width + (width - 1);
            if (like[leftIndex] > 0.5) enqueue(0, y);
            if (like[rightIndex] > 0.5) enqueue(width - 1, y);
        }

        const neighbours = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ] as const;

        while (head < tail) {
            const x = queueX[head];
            const y = queueY[head];
            head++;
            const idx = y * width + x;
            like[idx] = 1.0;
            for (const [dx, dy] of neighbours) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                    continue;
                }
                const nIdx = ny * width + nx;
                if (!seen[nIdx] && like[nIdx] > 0.5) {
                    enqueue(nx, ny);
                }
            }
        }

        const mask = new Float32Array(totalPixels);
        for (let i = 0; i < totalPixels; i++) {
            mask[i] = like[i] >= 1 ? 1 : 0;
        }

        if (feather > 0) {
            const radius = Math.max(1, Math.floor(feather));
            applyFeather(mask, width, height, radius);
        }

        for (let pixel = 0, offset = 0; pixel < totalPixels; pixel++, offset += 4) {
            data[offset + 3] = Math.round((1 - mask[pixel]) * 255);
        }

        ctx.putImageData(imgData, 0, 0);
        return canvas.toDataURL('image/png');
    } catch (error) {
        console.error('Error processing image for transparency:', error);
        return imageUrl;
    }
};
