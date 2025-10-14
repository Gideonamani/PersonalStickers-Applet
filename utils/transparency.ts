import type { TransparencyOptions, TransparencySeed } from '../types';
import { MAX_STICKER_DIMENSION } from './image';

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

const applyFeather = (mask: Float32Array, width: number, height: number, radius: number) => {
    if (radius <= 0) {
        return;
    }
    const tmp = new Float32Array(mask.length);

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
        seedPoints = [],
        mode = 'auto',
        maxDimension = MAX_STICKER_DIMENSION,
    } = opts;

    try {
        const img = await loadImage(imageUrl);

        const canvas = document.createElement('canvas');
        const largestSide = Math.max(img.width, img.height);
        let width = img.width;
        let height = img.height;

        if (maxDimension && largestSide > maxDimension) {
            const scale = maxDimension / largestSide;
            width = Math.max(1, Math.round(img.width * scale));
            height = Math.max(1, Math.round(img.height * scale));
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
            throw new Error('Could not get canvas context');
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

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

        const samples: RGBTuple[] = [];
        const normalizeSeed = ({ x, y, force }: TransparencySeed) => ({
            x: Math.max(0, Math.min(width - 1, Math.round(x))),
            y: Math.max(0, Math.min(height - 1, Math.round(y))),
            force: force ?? true,
        });
        const seeds = (seedPoints ?? []).map(normalizeSeed);
        const addSample = (x: number, y: number) => {
            if (x < 0 || x >= width || y < 0 || y >= height) {
                return;
            }
            const offset = (y * width + x) * 4;
            samples.push([data[offset], data[offset + 1], data[offset + 2]]);
        };

        const edgeStep = Math.max(1, Math.floor(Math.min(width, height) / Math.max(8, tileGuess)));
        if (mode !== 'seed') {
            for (let x = 0; x < width; x += edgeStep) {
                addSample(x, 0);
                addSample(x, height - 1);
            }
            for (let y = 0; y < height; y += edgeStep) {
                addSample(0, y);
                addSample(width - 1, y);
            }
            addSample(0, 0);
            addSample(width - 1, 0);
            addSample(0, height - 1);
            addSample(width - 1, height - 1);
        }
        for (const { x, y } of seeds) {
            for (let i = 0; i < 4; i++) {
                addSample(x, y);
            }
        }

        if (samples.length === 0) {
            return imageUrl;
        }

        type Cluster = { lab: LabTuple; rgb: RGBTuple; count: number };
        const clusters: Cluster[] = [];
        const clusterMergeTol = Math.max(4, colorTol * 0.6);

        for (const rgb of samples) {
            const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
            let bestIndex = -1;
            let bestDist = Number.POSITIVE_INFINITY;
            clusters.forEach((cluster, index) => {
                const d = distLab(lab[0], lab[1], lab[2], cluster.lab);
                if (d < clusterMergeTol && d < bestDist) {
                    bestDist = d;
                    bestIndex = index;
                }
            });
            if (bestIndex >= 0) {
                const cluster = clusters[bestIndex];
                const count = cluster.count + 1;
                const newLab: LabTuple = [
                    (cluster.lab[0] * cluster.count + lab[0]) / count,
                    (cluster.lab[1] * cluster.count + lab[1]) / count,
                    (cluster.lab[2] * cluster.count + lab[2]) / count,
                ];
                const newRgb: RGBTuple = [
                    (cluster.rgb[0] * cluster.count + rgb[0]) / count,
                    (cluster.rgb[1] * cluster.count + rgb[1]) / count,
                    (cluster.rgb[2] * cluster.count + rgb[2]) / count,
                ];
                cluster.lab = newLab;
                cluster.rgb = newRgb;
                cluster.count = count;
            } else {
                clusters.push({ lab, rgb, count: 1 });
            }
        }

        clusters.sort((a, b) => b.count - a.count);
        const bgClusters = clusters.slice(0, Math.min(2, clusters.length));
        if (bgClusters.length < 2) {
            for (const seed of seeds) {
                const offset = (seed.y * width + seed.x) * 4;
                const lab = rgbToLab(data[offset], data[offset + 1], data[offset + 2]);
                const closest = bgClusters.find((cluster) => distLab(lab[0], lab[1], lab[2], cluster.lab) < 2);
                if (!closest) {
                    bgClusters.push({
                        lab,
                        rgb: [data[offset], data[offset + 1], data[offset + 2]],
                        count: 1,
                    });
                    if (bgClusters.length >= 2) {
                        break;
                    }
                }
            }
        }
        if (bgClusters.length === 0) {
            return imageUrl;
        }

        const bgLabs = bgClusters.map((cluster) => cluster.lab);
        if (bgLabs.length === 1) {
            bgLabs.push(bgLabs[0]);
        }

        let tolerance = Math.max(colorTol, 12);
        if (bgLabs.length >= 2) {
            const [lab1, lab2] = bgLabs;
            const clusterDistance = distLab(lab1[0], lab1[1], lab1[2], lab2);
            tolerance = Math.min(45, Math.max(tolerance, clusterDistance * 0.45));
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

        const distanceToBackground = (index: number) => {
            const l = labL[index];
            const a = labA[index];
            const b = labB[index];
            let shortest = Number.POSITIVE_INFINITY;
            for (const lab of bgLabs) {
                const d = distLab(l, a, b, lab);
                if (d < shortest) {
                    shortest = d;
                }
            }
            return shortest;
        };

        const queueX = new Int32Array(totalPixels);
        const queueY = new Int32Array(totalPixels);
        const visited = new Uint8Array(totalPixels);
        let head = 0;
        let tail = 0;

        const useAuto = mode !== 'seed';
        const useSeeds = seeds.length > 0 && mode !== 'auto';

        const tryEnqueue = (x: number, y: number, force = false) => {
            if (x < 0 || x >= width || y < 0 || y >= height) {
                return;
            }
            const idx = y * width + x;
            if (visited[idx]) {
                return;
            }
            const dist = distanceToBackground(idx);
            const threshold = force ? tolerance * 1.35 : tolerance;
            if (dist > threshold) {
                return;
            }
            if (!force && gradKeep > 0 && grad[idx] > gradKeep && dist > tolerance * 0.4) {
                return;
            }
            visited[idx] = 1;
            queueX[tail] = x;
            queueY[tail] = y;
            tail++;
        };

        if (useAuto) {
            for (let x = 0; x < width; x += edgeStep) {
                tryEnqueue(x, 0, true);
                tryEnqueue(x, height - 1, true);
            }
            for (let y = 0; y < height; y += edgeStep) {
                tryEnqueue(0, y, true);
                tryEnqueue(width - 1, y, true);
            }
        }
        if (useSeeds) {
            for (const seed of seeds) {
                tryEnqueue(seed.x, seed.y, seed.force);
            }
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
            for (const [dx, dy] of neighbours) {
                tryEnqueue(x + dx, y + dy);
            }
        }

        const mask = new Float32Array(totalPixels);
        for (let i = 0; i < totalPixels; i++) {
            mask[i] = visited[i] ? 1 : 0;
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
