export const MAX_STICKER_DIMENSION = 512;

const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to load image'));
        image.src = src;
    });

export const normalizeImageSize = async (
    dataUrl: string,
    maxDimension: number = MAX_STICKER_DIMENSION,
): Promise<{ dataUrl: string; width: number; height: number }> => {
    const img = await loadImage(dataUrl);
    const largestSide = Math.max(img.width, img.height);

    if (!largestSide || largestSide <= maxDimension) {
        return { dataUrl, width: img.width, height: img.height };
    }

    const scale = maxDimension / largestSide;
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return { dataUrl, width: img.width, height: img.height };
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);

    return { dataUrl: canvas.toDataURL('image/png'), width, height };
};

export const dataUrlToBlob = (dataUrl: string): Blob => {
    const [header, base64 = ''] = dataUrl.split(',');
    const mimeMatch = header.match(/data:(.*?);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const binaryString = atob(base64);
    const length = binaryString.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
};
