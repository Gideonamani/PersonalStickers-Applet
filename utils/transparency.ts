import type { TransparencyOptions } from '../types';

export const makeBackgroundTransparent = (imageUrl: string, opts: Partial<TransparencyOptions> = {}): Promise<string> => {
    return new Promise(async (resolve) => {
        try {
            const {
                colorTol = 10,
                tileGuess = 16,
                gradKeep = 10,
                feather = 2
            } = opts;

            const img = await new Promise<HTMLImageElement>((res, rej) => {
                const im = new Image();
                im.crossOrigin = 'anonymous';
                im.onload = () => res(im);
                im.onerror = () => rej(new Error('Image failed to load'));
                im.src = imageUrl;
            });

            const canvas = document.createElement('canvas');
            const W = canvas.width = img.width; 
            const H = canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Could not get canvas context');
            ctx.drawImage(img, 0, 0);
            
            const imgData = ctx.getImageData(0, 0, W, H);
            const d = imgData.data;
            const rgb2lab = (r: number, g: number, b: number): number[] => {
                const srgb = [r / 255, g / 255, b / 255].map(u =>
                    u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4)
                );
                const [R, G, B] = srgb;
                const X = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B;
                const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
                const Z = 0.0193339 * R + 0.1191920 * G + 0.9503041 * B;
                const xn = 0.95047, yn = 1.00000, zn = 1.08883;
                const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
                const fx = f(X / xn), fy = f(Y / yn), fz = f(Z / zn);
                return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
            };
            const distLab = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
            const medianColor = (samples: number[][]): number[] => {
                const rs = samples.map(p => p[0]).sort((a, b) => a - b);
                const gs = samples.map(p => p[1]).sort((a, b) => a - b);
                const bs = samples.map(p => p[2]).sort((a, b) => a - b);
                return [rs[(rs.length / 2) | 0], gs[(gs.length / 2) | 0], bs[(bs.length / 2) | 0]];
            }
            const pickPatch = (x0: number, y0: number, sz = 24): number[][] => {
                const arr: number[][] = [];
                for (let y = y0; y < y0 + sz; y++) {
                    for (let x = x0; x < x0 + sz; x++) {
                        const i = (y * W + x) * 4; arr.push([d[i], d[i + 1], d[i + 2]]);
                    }
                } return arr;
            }
            const corners = [
                ...pickPatch(0, 0), ...pickPatch(W - 24, 0),
                ...pickPatch(0, H - 24), ...pickPatch(W - 24, H - 24)
            ];
            const Ls = corners.map(([r, g, b]) => rgb2lab(r, g, b)[0]);
            const Lmed = Ls.slice().sort((a, b) => a - b)[(Ls.length / 2) | 0];
            const light: number[][] = [], dark: number[][] = [];
            corners.forEach((rgb, i) => (Ls[i] >= Lmed ? light : dark).push(rgb));
            const c1 = medianColor(light);
            const c2 = medianColor(dark);
            const c1Lab = rgb2lab(c1[0], c1[1], c1[2]), c2Lab = rgb2lab(c2[0], c2[1], c2[2]);
            const scorePeriod = (p: number): number => {
                let score = 0, step = Math.max(1, Math.floor(W / 64));
                for (let y = 0; y < H; y += step) {
                    for (let x = 0; x < W; x += step) {
                        const i = (y * W + x) * 4; const lab = rgb2lab(d[i], d[i + 1], d[i + 2]);
                        const parity = ((Math.floor(x / p) + Math.floor(y / p)) & 1);
                        const dc1 = distLab(lab, c1Lab), dc2 = distLab(lab, c2Lab);
                        const match = (parity ? dc2 < dc1 : dc1 < dc2);
                        if (Math.min(dc1, dc2) < colorTol && match) score++;
                    }
                }
                return score;
            }
            let bestP = tileGuess, bestS = -1;
            for (let p = Math.max(8, tileGuess - 6); p <= tileGuess + 6; p++) {
                const s = scorePeriod(p); if (s > bestS) { bestS = s; bestP = p; }
            }
            const P = bestP;
            const grad = new Float32Array(W * H);
            const get = (x: number, y: number, c: number) => d[(y * W + x) * 4 + c];
            for (let y = 1; y < H - 1; y++) {
                for (let x = 1; x < W - 1; x++) {
                    const lum = (xx: number, yy: number) => 0.2126 * get(xx, yy, 0) + 0.7152 * get(xx, yy, 1) + 0.0722 * get(xx, yy, 2);
                    const gx = -lum(x - 1, y - 1) - 2 * lum(x - 1, y) - lum(x - 1, y + 1)
                        + lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1);
                    const gy = -lum(x - 1, y - 1) - 2 * lum(x, y - 1) - lum(x + 1, y - 1)
                        + lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1);
                    grad[y * W + x] = Math.hypot(gx, gy) / 8;
                }
            }
            const like = new Float32Array(W * H);
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = (y * W + x) * 4;
                    const lab = rgb2lab(d[i], d[i + 1], d[i + 2]);
                    const dc1 = distLab(lab, c1Lab), dc2 = distLab(lab, c2Lab);
                    const parity = ((Math.floor(x / P) + Math.floor(y / P)) & 1);
                    const dc = parity ? dc2 : dc1;
                    let L = Math.max(0, 1 - dc / colorTol);
                    const g = grad[y * W + x];
                    if (g > gradKeep) L *= 0.2;
                    like[y * W + x] = L;
                }
            }
            const qx = new Int32Array(W * H), qy = new Int32Array(W * H);
            const seen = new Uint8Array(W * H);
            let qh = 0, qt = 0;
            const push = (x: number, y: number) => { const k = y * W + x; if (seen[k]) return; seen[k] = 1; qx[qt] = x; qy[qt] = y; qt++; }
            for (let x = 0; x < W; x++) { if (like[x] > .5) push(x, 0); if (like[(H - 1) * W + x] > .5) push(x, H - 1); }
            for (let y = 0; y < H; y++) { if (like[y * W] > .5) push(0, y); if (like[y * W + W - 1] > .5) push(W - 1, y); }
            while (qh < qt) {
                const x = qx[qh], y = qy[qh]; qh++;
                like[y * W + x] = 1.0;
                [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
                    const nx = x + dx, ny = y + dy;
                    if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                        const k = ny * W + nx;
                        if (!seen[k] && like[k] > .5) push(nx, ny);
                    }
                });
            }
            const mask = new Float32Array(W * H);
            for (let i = 0; i < W * H; i++) mask[i] = like[i] >= 1.0 ? 1 : 0;
            if (feather > 0) {
                const r = Math.max(1, Math.floor(feather));
                const tmp = new Float32Array(W * H);
                for (let y = 0; y < H; y++) {
                    for (let x = 0; x < W; x++) {
                        let sum = 0, cnt = 0;
                        for (let yy = y - r; yy <= y + r; yy++) {
                            for (let xx = x - r; xx <= x + r; xx++) {
                                if (xx >= 0 && xx < W && yy >= 0 && yy < H) { sum += mask[yy * W + xx]; cnt++; }
                            }
                        }
                        tmp[y * W + x] = sum / cnt;
                    }
                }
                mask.set(tmp);
            }
            for (let i = 0; i < W * H; i++) {
                d[i * 4 + 3] = Math.round((1 - mask[i]) * 255);
            }
            ctx.putImageData(imgData, 0, 0);
            resolve(canvas.toDataURL('image/png'));
        } catch (error) {
            console.error('Error processing image for transparency:', error);
            resolve(imageUrl);
        }
    });
};
