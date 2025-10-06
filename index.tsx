/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import React, { useState, ChangeEvent, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Modality } from '@google/genai';
import JSZip from 'jszip';
import ReactCrop, { centerCrop, makeAspectCrop, type Crop, type PixelCrop } from 'react-image-crop';

import './index.css';

// --- Gemini API Configuration ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- App Constants ---
const INITIAL_EXPRESSIONS = [
  { emoji: '👍', label: 'Thumbs up' },
  { emoji: '😏', label: 'Cheeky smile' },
  { emoji: '😉', label: 'Naughty wink' },
  { emoji: '😎', label: 'Cool shades' },
  { emoji: '👏', label: 'Slow clap' },
  { emoji: '😔', label: 'Sad sigh' },
  { emoji: '🤦', label: 'Facepalm frustration' },
  { emoji: '☹️', label: 'Frown lips' },
  { emoji: '😋', label: 'Tongue out' },
  { emoji: '🤔', label: 'Curious thinking' },
];

const POPULAR_EMOJIS = [
    '😊', '😂', '😍', '🥰', '😎', '🤔', '😉', '😋', '😜', '🤪', 
    '🤩', '🥳', '😏', '😒', '😞', '😔', '😢', '😭', '😱', '😡',
    '😠', '🤯', '🥺', '🤗', '🤫', '😬', '🙄', '🤤', '😴', '🤧',
    '😇', '🤣', '😅', '😆', '🥲', '😘', '🤨', '🧐', '🤓', '😮',
    '😲', '😳', '😨', '😥', '👍', '👎', '👌', '✌️', '👏', '🙏'
];


type StickerStatus = 'idle' | 'loading' | 'done' | 'error';
type Sticker = {
    emoji: string;
    label: string;
    imageUrl: string | null; // The final image to display/download
    originalImageUrl: string | null; // The raw image from the AI, for reprocessing
    status: StickerStatus;
};
type Expression = {
    emoji: string;
    label: string;
};
type TransparencyOptions = {
    colorTol: number;
    tileGuess: number;
    gradKeep: number;
    feather: number;
};


// --- Helper Functions ---
const dataUrlToBase64 = (dataUrl: string) => dataUrl.split(',')[1];

const downloadImage = (imageUrl: string, filename: string) => {
  const link = document.createElement('a');
  link.href = imageUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

/**
 * Processes an image data URL to make checkerboard-like backgrounds transparent.
 * This is an advanced algorithm that uses CIELAB color difference, robust color sampling,
 * and gradient detection to intelligently identify and remove checkerboard patterns
 * while preserving the subject.
 * @param imageUrl The base64 data URL of the image to process.
 * @param opts Options for tuning the algorithm.
 * @returns A promise that resolves with the new data URL of the processed image.
 */
const makeBackgroundTransparent = (imageUrl: string, opts: Partial<TransparencyOptions> = {}): Promise<string> => {
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

            // --- helpers ---
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
                return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]; // L*, a*, b*
            };
            const distLab = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

            // --- 1) Sample two checker colors from corners (robust median) ---
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

            // --- 2) Estimate checker tile period ---
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

            // --- 3) Precompute gradient magnitude ---
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

            // --- 4) Build background-likelihood map ---
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

            // --- 5) Edge-connected flood fill ---
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

            // --- 6) Feather mask and apply alpha ---
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
            resolve(imageUrl); // Fallback to original image
        }
    });
};

// --- React Components ---

const Header = () => (
  <header className="app-header">
    <h1>StickerMe</h1>
  </header>
);

const ImageCropper = ({
    imageSrc,
    onSave,
    onCancel,
  }: {
    imageSrc: string;
    onSave: (croppedImageDataUrl: string) => void;
    onCancel: () => void;
  }) => {
    const [crop, setCrop] = useState<Crop>();
    const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
    const imgRef = useRef<HTMLImageElement>(null);
  
    function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
      const { width, height } = e.currentTarget;
      const initialCrop = centerCrop(
        makeAspectCrop({ unit: '%', width: 90 }, 1, width, height),
        width,
        height
      );
      setCrop(initialCrop);
    }
  
    const handleCrop = async () => {
      if (completedCrop?.width && completedCrop?.height && imgRef.current) {
        const canvas = document.createElement('canvas');
        const scaleX = imgRef.current.naturalWidth / imgRef.current.width;
        const scaleY = imgRef.current.naturalHeight / imgRef.current.height;
        canvas.width = completedCrop.width;
        canvas.height = completedCrop.height;
        const ctx = canvas.getContext('2d');
  
        if (ctx) {
          ctx.drawImage(
            imgRef.current,
            completedCrop.x * scaleX,
            completedCrop.y * scaleY,
            completedCrop.width * scaleX,
            completedCrop.height * scaleY,
            0,
            0,
            completedCrop.width,
            completedCrop.height
          );
          const base64Image = canvas.toDataURL('image/png');
          onSave(base64Image);
        }
      }
    };

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
    };
  
    return (
      <div className="crop-modal" onClick={handleBackdropClick}>
        <div className="crop-modal-content">
          <h3>Crop your image</h3>
          <p>Select the portion of the image you want to turn into a sticker.</p>
          <div className="crop-container">
            <ReactCrop
              crop={crop}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
              onComplete={(c) => setCompletedCrop(c)}
              aspect={1}
            >
              <img ref={imgRef} src={imageSrc} onLoad={onImageLoad} alt="Image to crop"/>
            </ReactCrop>
          </div>
          <div className="crop-modal-actions">
            <button onClick={onCancel} className="modal-button secondary">Cancel</button>
            <button onClick={handleCrop} className="modal-button primary">Crop & Use</button>
          </div>
        </div>
      </div>
    );
  };

const StickerCreator = ({
  characterImage,
  onFileSelect,
  onGenerate,
  isLoading,
  backgroundColor,
  onBackgroundColorChange,
  transparentBackground,
  onTransparentChange,
  artisticStyle,
  onArtisticStyleChange,
}: {
  characterImage: string | null;
  onFileSelect: (file: File | null | undefined) => void;
  onGenerate: () => void;
  isLoading: boolean;
  backgroundColor: string;
  onBackgroundColorChange: (event: ChangeEvent<HTMLInputElement>) => void;
  transparentBackground: boolean;
  onTransparentChange: (event: ChangeEvent<HTMLInputElement>) => void;
  artisticStyle: string;
  onArtisticStyleChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault(); // Necessary to allow drop
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      onFileSelect(file);
    }
  };

  const handleDisplayClick = () => {
    fileInputRef.current?.click();
  };


  return (
    <div className="sticker-creator">
      <div
        className={`character-display ${isDragging ? 'drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleDisplayClick}
        role="button"
        tabIndex={0}
      >
        {characterImage ? (
            <img src={characterImage} alt="Uploaded character" className="character-image" />
        ) : (
            <div className="character-placeholder">
              <span>📷</span>
              <span className="placeholder-text">Drag & drop an image or click to upload</span>
            </div>
        )}
      </div>
      <div className="creator-controls">
        <h2>Your Personal Sticker Studio</h2>
        <div className="instructions">
            <h4>How it works:</h4>
            <ol>
                <li><span>Upload a photo</span> of a person, pet, or character.</li>
                <li><span>Choose your style</span> and background options.</li>
                <li><span>Generate Stickers</span> and watch the AI create a unique pack!</li>
            </ol>
        </div>
        <div className="style-controls">
          <label htmlFor="artisticStyle">Artistic Style</label>
          <select id="artisticStyle" value={artisticStyle} onChange={onArtisticStyleChange}>
            <option value="Photo-realistic">Photo-realistic</option>
            <option value="Anime">Anime</option>
            <option value="3D Render">3D Render</option>
          </select>
        </div>
        <div className="background-controls">
            <input
                type="checkbox"
                id="transparentBg"
                checked={transparentBackground}
                onChange={onTransparentChange}
            />
            <label htmlFor="transparentBg">Transparent Background</label>
            <input
                type="color"
                id="bgColorPicker"
                value={backgroundColor}
                onChange={onBackgroundColorChange}
                disabled={transparentBackground}
                aria-label="Background color picker"
            />
        </div>
        <div className="button-group">
            <input
                type="file"
                accept="image/*"
                onChange={(e) => onFileSelect(e.target.files?.[0])}
                onClick={(e: React.MouseEvent<HTMLInputElement>) => {
                  e.currentTarget.value = '';
                }}
                style={{ display: 'none' }}
                ref={fileInputRef}
                id="imageUpload"
            />
             <label htmlFor="imageUpload" className="upload-button">
                Upload Image
            </label>
            <button onClick={onGenerate} className="generate-button" disabled={isLoading || !characterImage}>
                {isLoading ? 'Generating...' : 'Generate Stickers'}
            </button>
        </div>
      </div>
    </div>
  );
};

const EmojiPicker = ({ onSelect }: { onSelect: (emoji: string) => void }) => {
    return (
      <div className="emoji-picker">
        {POPULAR_EMOJIS.map(emoji => (
          <button key={emoji} onClick={() => onSelect(emoji)} className="emoji-picker-btn">
            {emoji}
          </button>
        ))}
      </div>
    );
};

const AddExpressionModal = ({ onAdd, onClose }: { onAdd: (expression: Expression) => void; onClose: () => void }) => {
    const [newEmoji, setNewEmoji] = useState('😀');
    const [newLabel, setNewLabel] = useState('');
    const [isPickerOpen, setPickerOpen] = useState(false);
    const pickerRef = useRef<HTMLDivElement>(null);
    const modalContentRef = useRef<HTMLDivElement>(null);

    const handleAdd = (e: React.FormEvent) => {
      e.preventDefault();
      if (newEmoji && newLabel) {
        onAdd({ emoji: newEmoji, label: newLabel });
      }
    };
  
    const handleEmojiSelect = (emoji: string) => {
      setNewEmoji(emoji);
      setPickerOpen(false);
    };

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (modalContentRef.current && !modalContentRef.current.contains(e.target as Node)) {
          onClose();
        }
    };
  
    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
          setPickerOpen(false);
        }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }, []);
  
    return (
      <div className="modal-backdrop" onClick={handleBackdropClick}>
        <div className="modal-content" ref={modalContentRef}>
          <h3>Add New Expression</h3>
          <form onSubmit={handleAdd} className="add-expression-modal-form">
            <div className="form-row">
                <div className="emoji-input-wrapper" ref={pickerRef}>
                    <button type="button" onClick={() => setPickerOpen(!isPickerOpen)} className="emoji-input-btn">
                        {newEmoji}
                    </button>
                    {isPickerOpen && <EmojiPicker onSelect={handleEmojiSelect} />}
                </div>
                <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="Label (e.g., Laughing)"
                    className="label-input"
                    required
                    autoFocus
                />
            </div>
            <div className="modal-actions">
              <button type="button" onClick={onClose} className="modal-button secondary">Cancel</button>
              <button type="submit" className="modal-button primary">Add Expression</button>
            </div>
          </form>
        </div>
      </div>
    );
  };

const TransparencyEditorModal = ({ sticker, onSave, onClose }: { sticker: Sticker; onSave: (label: string, newImageUrl: string) => void; onClose: () => void; }) => {
    const [params, setParams] = useState<TransparencyOptions>({
        colorTol: 10,
        tileGuess: 16,
        gradKeep: 10,
        feather: 2,
    });
    const [previewUrl, setPreviewUrl] = useState(sticker.imageUrl);
    const [isProcessing, setIsProcessing] = useState(false);
    const modalContentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!sticker.originalImageUrl) return;

        setIsProcessing(true);
        const handler = setTimeout(() => {
            makeBackgroundTransparent(sticker.originalImageUrl!, params).then(newUrl => {
                setPreviewUrl(newUrl);
                setIsProcessing(false);
            });
        }, 300); // Debounce processing

        return () => {
            clearTimeout(handler);
        };
    }, [params, sticker.originalImageUrl]);

    const handleParamChange = (paramName: keyof TransparencyOptions, value: string) => {
        setParams(prev => ({ ...prev, [paramName]: Number(value) }));
    };

    const handleSave = () => {
        if (previewUrl) {
            onSave(sticker.label, previewUrl);
        }
    };
    
    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (modalContentRef.current && !modalContentRef.current.contains(e.target as Node)) {
          onClose();
        }
    };

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="transparency-editor-modal" ref={modalContentRef}>
                <h3>Fine-tune Transparency</h3>
                <div className="editor-content">
                    <div className="editor-preview">
                        <div className="checkerboard-bg">
                            {isProcessing && <div className="preview-spinner-overlay"><div className="spinner"></div></div>}
                            <img src={previewUrl || ''} alt={`${sticker.label} preview`} />
                        </div>
                    </div>
                    <div className="editor-controls">
                        <div className="slider-control">
                            <label htmlFor="colorTol">Color Tolerance ({params.colorTol})</label>
                            <input type="range" id="colorTol" min="4" max="24" value={params.colorTol} onChange={e => handleParamChange('colorTol', e.target.value)} />
                        </div>
                        <div className="slider-control">
                            <label htmlFor="tileGuess">Tile Size ({params.tileGuess})</label>
                            <input type="range" id="tileGuess" min="8" max="32" value={params.tileGuess} onChange={e => handleParamChange('tileGuess', e.target.value)} />
                        </div>
                        <div className="slider-control">
                            <label htmlFor="gradKeep">Texture Protection ({params.gradKeep})</label>
                            <input type="range" id="gradKeep" min="4" max="24" value={params.gradKeep} onChange={e => handleParamChange('gradKeep', e.target.value)} />
                        </div>
                        <div className="slider-control">
                            <label htmlFor="feather">Edge Feather ({params.feather})</label>
                            <input type="range" id="feather" min="0" max="8" value={params.feather} onChange={e => handleParamChange('feather', e.target.value)} />
                        </div>
                    </div>
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="modal-button secondary">Cancel</button>
                    <button onClick={handleSave} className="modal-button primary">Save Changes</button>
                </div>
            </div>
        </div>
    );
};


// --- Icon Components ---
const DownloadIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
    <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
    <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
  </svg>
);

const BinIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
        <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
        <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
    </svg>
);

const EditIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
        <path d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708l-3-3zm.646 6.061L9.793 2.5 3.293 9H3.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.207l6.5-6.5zm-7.468 7.468A.5.5 0 0 1 6 13.5V13h-.5a.5.5 0 0 1-.5-.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.499.499 0 0 1-.175-.032l-.179.178a.5.5 0 0 0-.11.168l-2 5a.5.5 0 0 0 .65.65l5-2a.5.5 0 0 0 .168-.11l.178-.178z"/>
    </svg>
);

const RegenerateIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
        <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"/>
        <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466"/>
    </svg>
);

const AddIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="currentColor" viewBox="0 0 16 16">
        <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4"/>
    </svg>
);


const StickerItem: React.FC<{ sticker: Sticker, originalFilename: string | null, onRemove: (label: string) => void; onEdit: (sticker: Sticker) => void; onRegenerate: (label: string) => void; }> = ({ sticker, originalFilename, onRemove, onEdit, onRegenerate }) => {
    const handleDownload = () => {
        if (sticker.imageUrl) {
          const prefix = originalFilename ? originalFilename.split('.').slice(0, -1).join('.') : 'sticker';
          const stickerName = sticker.label.replace(/\s+/g, '_');
          downloadImage(sticker.imageUrl, `${prefix}_${stickerName}.png`);
        }
    };
    
    const canInteract = sticker.status !== 'loading';

    const renderContent = () => {
        switch (sticker.status) {
            case 'loading':
            return <div className="spinner"></div>;
            case 'done':
            return <img src={sticker.imageUrl!} alt={sticker.label} className="sticker-image" />;
            case 'error':
            return <span className="sticker-emoji" role="img" aria-label="Error">⚠️</span>;
            case 'idle':
            default:
            return <span className="sticker-emoji" role="img" aria-label={sticker.label}>{sticker.emoji}</span>;
        }
    };

    return (
    <div className="sticker-item">
        {canInteract && (
            <div className="sticker-item-actions">
                {(sticker.status === 'done' || sticker.status === 'error') && (
                    <button
                        className="sticker-action-btn regenerate-btn"
                        onClick={() => onRegenerate(sticker.label)}
                        aria-label={`Regenerate ${sticker.label} sticker`}
                        title="Regenerate"
                    >
                        <RegenerateIcon />
                    </button>
                )}
                {sticker.status === 'done' && sticker.originalImageUrl && (
                     <button
                        className="sticker-action-btn edit-btn"
                        onClick={() => onEdit(sticker)}
                        aria-label={`Edit transparency for ${sticker.label}`}
                        title="Edit Transparency"
                    >
                        <EditIcon />
                    </button>
                )}
                <button
                    className="sticker-action-btn delete-btn"
                    onClick={() => onRemove(sticker.label)}
                    aria-label={`Delete ${sticker.label} expression`}
                    title={`Delete ${sticker.label}`}
                >
                    <BinIcon />
                </button>
            </div>
        )}
        <div className="sticker-placeholder">
            {renderContent()}
            <div className="sticker-label">
                <span>{sticker.label}</span>
                {sticker.imageUrl && sticker.status === 'done' && (
                <button onClick={handleDownload} className="download-button" aria-label={`Download ${sticker.label} sticker`}>
                    <DownloadIcon />
                </button>
                )}
            </div>
        </div>
    </div>
    );
};

type GridSize = 'small' | 'medium' | 'large';

const StickerGrid = ({ stickers, originalFilename, gridSize, onAddClick, onRemove, onEdit, onRegenerate }: { stickers: Sticker[]; originalFilename: string | null; gridSize: GridSize; onAddClick: () => void; onRemove: (label: string) => void; onEdit: (sticker: Sticker) => void; onRegenerate: (label: string) => void; }) => (
  <section className={`sticker-grid size-${gridSize}`}>
    {stickers.map((sticker) => (
      <StickerItem key={sticker.label} sticker={sticker} originalFilename={originalFilename} onRemove={onRemove} onEdit={onEdit} onRegenerate={onRegenerate} />
    ))}
    <button className="add-sticker-btn" onClick={onAddClick} aria-label="Add new expression">
        <AddIcon />
        <span>Add Expression</span>
    </button>
  </section>
);

const Footer = () => (
    <footer className="app-footer">
      Built with enthusiasm by Keon on AI Studio
    </footer>
  );

const App = () => {
  const [expressions, setExpressions] = useState<Expression[]>(INITIAL_EXPRESSIONS);
  const [userImage, setUserImage] = useState<{ data: string; mimeType: string; } | null>(null);
  const [originalFilename, setOriginalFilename] = useState<string | null>(null);
  const [stickers, setStickers] = useState<Sticker[]>(
    INITIAL_EXPRESSIONS.map(e => ({ ...e, imageUrl: null, originalImageUrl: null, status: 'idle' as const }))
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backgroundColor, setBackgroundColor] = useState('#FFFFFF');
  const [transparentBackground, setTransparentBackground] = useState(true);
  const [imageToCrop, setImageToCrop] = useState<string | null>(null);
  const [isCropModalOpen, setCropModalOpen] = useState(false);
  const [artisticStyle, setArtisticStyle] = useState('Photo-realistic');
  const [gridSize, setGridSize] = useState<GridSize>('medium');
  const [isAddModalOpen, setAddModalOpen] = useState(false);
  const [editingSticker, setEditingSticker] = useState<Sticker | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const LOCAL_STORAGE_KEY = 'stickerMeSession';

  // Load state from localStorage on initial mount
  useEffect(() => {
    try {
      const savedStateJSON = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (savedStateJSON) {
        const savedState = JSON.parse(savedStateJSON);
        if (savedState.expressions && Array.isArray(savedState.expressions)) {
          setExpressions(savedState.expressions);
        }
        if (savedState.originalFilename) {
          setOriginalFilename(savedState.originalFilename);
        }
        if (savedState.artisticStyle) {
          setArtisticStyle(savedState.artisticStyle);
        }
        if (savedState.backgroundColor) {
          setBackgroundColor(savedState.backgroundColor);
        }
        if (typeof savedState.transparentBackground === 'boolean') {
          setTransparentBackground(savedState.transparentBackground);
        }
        if (savedState.gridSize) {
          setGridSize(savedState.gridSize);
        }
      }
    } catch (e) {
      console.error("Failed to load state from localStorage", e);
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    } finally {
      setIsInitialized(true);
    }
  }, []);

  // Save state to localStorage whenever settings or expressions change
  useEffect(() => {
    if (!isInitialized) {
      return; // Don't save until initial state is loaded
    }
    try {
      // Create a snapshot of the session data that we want to persist.
      // Importantly, we do NOT save any image data (userImage, sticker images)
      // to avoid exceeding localStorage limits and to ensure a fresh start on page load.
      const sessionData = {
        expressions,
        originalFilename, // We save the filename, not the image itself
        artisticStyle,
        backgroundColor,
        transparentBackground,
        gridSize,
      };
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(sessionData));
    } catch (e) {
      console.error("Failed to save state to localStorage. Your latest changes might not be saved.", e);
    }
  }, [
    expressions,
    originalFilename,
    artisticStyle,
    backgroundColor,
    transparentBackground,
    gridSize,
    isInitialized
  ]);

  useEffect(() => {
    // Keep stickers in sync with the expressions list
    setStickers(prevStickers => {
      const newStickers = expressions.map(exp => {
        const existingSticker = prevStickers.find(s => s.label === exp.label);
        return existingSticker || { ...exp, imageUrl: null, originalImageUrl: null, status: 'idle' as const };
      });
      // Filter out stickers whose expressions have been removed
      return newStickers.filter(s => expressions.some(e => e.label === s.label));
    });
  }, [expressions]);

  const handleAddExpression = (newExpression: Expression) => {
    if (!expressions.some(e => e.label.toLowerCase() === newExpression.label.toLowerCase())) {
        setExpressions(prev => [...prev, newExpression]);
        setError(null);
    } else {
        setError(`An expression with the label "${newExpression.label}" already exists.`);
    }
    setAddModalOpen(false);
  };

  const handleRemoveExpression = (labelToRemove: string) => {
    setExpressions(prev => prev.filter(e => e.label !== labelToRemove));
  };

  const handleFileSelect = (file: File | null | undefined) => {
    if (file && file.type.startsWith('image/')) {
      setOriginalFilename(file.name);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImageToCrop(reader.result as string);
        setCropModalOpen(true);
      };
      reader.readAsDataURL(file);
    } else if (file) {
      setError("Please select a valid image file (e.g., PNG, JPG, GIF).");
    }
  };

  const handleCropSave = (croppedImageDataUrl: string) => {
    setUserImage({
      data: croppedImageDataUrl,
      mimeType: 'image/png', // Canvas output is always png
    });
    // Reset stickers when a new image is uploaded
    setStickers(expressions.map(e => ({ ...e, imageUrl: null, originalImageUrl: null, status: 'idle' as const })));
    setError(null);
    setCropModalOpen(false);
  };

  const handleCropCancel = () => {
    setCropModalOpen(false);
    setImageToCrop(null);
  };

  const handleSaveTransparency = (label: string, newImageUrl: string) => {
    setStickers(prev => prev.map(s => s.label === label ? { ...s, imageUrl: newImageUrl } : s));
    setEditingSticker(null);
  };


  const handleGenerate = async () => {
    if (!userImage) {
        setError("Please upload an image first!");
        return;
    }
    if (expressions.length === 0) {
        setError("Please add at least one expression to generate stickers.");
        return;
    }
    setIsLoading(true);
    setError(null);
    setStickers(expressions.map(e => ({ ...e, imageUrl: null, originalImageUrl: null, status: 'idle' as const }))); // Reset stickers

    const sourceImage = { data: dataUrlToBase64(userImage.data), mimeType: userImage.mimeType };

    const backgroundInstruction = transparentBackground
      ? 'a transparent background. The output image must be a PNG with a true alpha channel, not a rendered checkerboard pattern representing transparency.'
      : `a solid, opaque background of the hex color ${backgroundColor}`;

    let styleInstruction = '';
    switch (artisticStyle) {
        case 'Anime':
        styleInstruction = 'a vibrant Anime/Manga style';
        break;
        case '3D Render':
        styleInstruction = 'a polished 3D render style, similar to modern animated films';
        break;
        case 'Photo-realistic':
        default:
        styleInstruction = 'a photo-realistic style, making it look like a real high-resolution photograph';
        break;
    }

    try {
      for (const expression of expressions) {
        setStickers(prev => prev.map(s => s.label === expression.label ? { ...s, status: 'loading' as const } : s));

        try {
            const prompt = `Generate a high-quality sticker of the character showing a "${expression.label}" expression. The artistic style MUST be ${styleInstruction}. The sticker must have ${backgroundInstruction} and a subtle white outline around the subject. The final output must be a PNG file. Ensure the style is consistent across all stickers. Do not add extra background elements or text.`;
            
            const response = await ai.models.generateContent({
              model: 'gemini-2.5-flash-image',
              contents: {
                parts: [
                  { inlineData: { data: sourceImage.data, mimeType: sourceImage.mimeType } },
                  { text: prompt },
                ],
              },
              config: {
                responseModalities: [Modality.IMAGE, Modality.TEXT],
              },
            });
            
            const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
            if (imagePart?.inlineData) {
              const originalImageUrl = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
              let processedImageUrl = originalImageUrl;
              
              if (transparentBackground) {
                try {
                  processedImageUrl = await makeBackgroundTransparent(originalImageUrl);
                } catch (processError) {
                  console.warn(`Could not process image for transparency, falling back to original.`, processError);
                }
              }

              setStickers(prevStickers =>
                prevStickers.map(s =>
                  s.label === expression.label ? { ...s, imageUrl: processedImageUrl, originalImageUrl, status: 'done' as const } : s
                )
              );
            } else {
                console.warn(`No image generated for: ${expression.label}`);
                setStickers(prevStickers => prevStickers.map(s => s.label === expression.label ? { ...s, status: 'error' as const } : s));
            }
        } catch(err) {
            console.error(`Error generating sticker for ${expression.label}:`, err);
            setStickers(prevStickers => prevStickers.map(s => s.label === expression.label ? { ...s, status: 'error' as const } : s));
        }
      }
    } catch (err) {
      console.error('Error during generation process:', err);
      setError('Sorry, a major error occurred while creating the stickers. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegenerate = async (label: string) => {
    if (!userImage) {
        setError("Please upload an image first to regenerate a sticker.");
        return;
    }

    const expression = expressions.find(e => e.label === label);
    if (!expression) {
        console.error("Expression not found for regeneration:", label);
        return;
    }

    setStickers(prev => prev.map(s => s.label === label ? { ...s, status: 'loading' as const } : s));
    setError(null);

    const sourceImage = { data: dataUrlToBase64(userImage.data), mimeType: userImage.mimeType };

    const backgroundInstruction = transparentBackground
      ? 'a transparent background. The output image must be a PNG with a true alpha channel, not a rendered checkerboard pattern representing transparency.'
      : `a solid, opaque background of the hex color ${backgroundColor}`;

    let styleInstruction = '';
    switch (artisticStyle) {
        case 'Anime':
        styleInstruction = 'a vibrant Anime/Manga style';
        break;
        case '3D Render':
        styleInstruction = 'a polished 3D render style, similar to modern animated films';
        break;
        case 'Photo-realistic':
        default:
        styleInstruction = 'a photo-realistic style, making it look like a real high-resolution photograph';
        break;
    }

    try {
        const prompt = `Generate a high-quality sticker of the character showing a "${expression.label}" expression. The artistic style MUST be ${styleInstruction}. The sticker must have ${backgroundInstruction} and a subtle white outline around the subject. The final output must be a PNG file. Ensure the style is consistent across all stickers. Do not add extra background elements or text.`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: {
            parts: [
                { inlineData: { data: sourceImage.data, mimeType: sourceImage.mimeType } },
                { text: prompt },
            ],
            },
            config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
            },
        });
        
        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            const originalImageUrl = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
            let processedImageUrl = originalImageUrl;
            
            if (transparentBackground) {
            try {
                processedImageUrl = await makeBackgroundTransparent(originalImageUrl);
            } catch (processError) {
                console.warn(`Could not process image for transparency, falling back to original.`, processError);
            }
            }

            setStickers(prevStickers =>
            prevStickers.map(s =>
                s.label === expression.label ? { ...s, imageUrl: processedImageUrl, originalImageUrl, status: 'done' as const } : s
            )
            );
        } else {
            console.warn(`No image generated for: ${expression.label}`);
            setStickers(prevStickers => prevStickers.map(s => s.label === expression.label ? { ...s, status: 'error' as const } : s));
        }
    } catch(err) {
        console.error(`Error generating sticker for ${expression.label}:`, err);
        setStickers(prevStickers => prevStickers.map(s => s.label === expression.label ? { ...s, status: 'error' as const } : s));
    }
  };

  const handleDownloadAll = () => {
    const zip = new JSZip();
    const generatedStickers = stickers.filter(s => s.imageUrl && s.status === 'done');

    if (generatedStickers.length === 0) return;

    const prefix = originalFilename ? originalFilename.split('.').slice(0, -1).join('.') : 'my';

    generatedStickers.forEach(sticker => {
      const base64Data = dataUrlToBase64(sticker.imageUrl!);
      const filename = `${prefix}_${sticker.label.replace(/\s+/g, '_')}.png`;
      zip.file(filename, base64Data, { base64: true });
    });

    zip.generateAsync({ type: 'blob' }).then(content => {
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${prefix}_sticker_pack.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  };

  const characterImage = userImage?.data || null;
  const hasGeneratedStickers = stickers.some(s => s.imageUrl);
  const hasGenerationStarted = stickers.some(s => s.status !== 'idle');

  return (
    <>
      <Header />
      <main>
        {isCropModalOpen && imageToCrop && (
          <ImageCropper
            imageSrc={imageToCrop}
            onSave={handleCropSave}
            onCancel={handleCropCancel}
          />
        )}
        {isAddModalOpen && (
            <AddExpressionModal
                onAdd={handleAddExpression}
                onClose={() => setAddModalOpen(false)}
            />
        )}
        {editingSticker && (
            <TransparencyEditorModal
                sticker={editingSticker}
                onSave={handleSaveTransparency}
                onClose={() => setEditingSticker(null)}
            />
        )}
        <StickerCreator
          characterImage={characterImage}
          onFileSelect={handleFileSelect}
          onGenerate={handleGenerate}
          isLoading={isLoading}
          backgroundColor={backgroundColor}
          onBackgroundColorChange={(e) => setBackgroundColor(e.target.value)}
          transparentBackground={transparentBackground}
          onTransparentChange={(e) => setTransparentBackground(e.target.checked)}
          artisticStyle={artisticStyle}
          onArtisticStyleChange={(e) => setArtisticStyle(e.target.value)}
        />
        <div className="generation-results">
            {hasGenerationStarted && (
                <div className="results-header">
                    <div className="results-header-info">
                        <p>Here are your generated stickers. Add more, or download them individually or all at once!</p>
                        <div className="display-size-toggler" role="group" aria-label="Sticker display size">
                            <span>View size:</span>
                            <button
                                className={`size-toggle-btn ${gridSize === 'small' ? 'active' : ''}`}
                                onClick={() => setGridSize('small')}
                                aria-pressed={gridSize === 'small'}
                                title="Small view"
                            >
                                S
                            </button>
                            <button
                                className={`size-toggle-btn ${gridSize === 'medium' ? 'active' : ''}`}
                                onClick={() => setGridSize('medium')}
                                aria-pressed={gridSize === 'medium'}
                                title="Medium view"
                            >
                                M
                            </button>
                            <button
                                className={`size-toggle-btn ${gridSize === 'large' ? 'active' : ''}`}
                                onClick={() => setGridSize('large')}
                                aria-pressed={gridSize === 'large'}
                                title="Large view"
                            >
                                L
                            </button>
                        </div>
                    </div>
                    <button onClick={handleDownloadAll} className="download-all-button" disabled={!hasGeneratedStickers}>
                        <DownloadIcon />
                        Download All (.zip)
                    </button>
                </div>
            )}
            {error && <p className="error-message" onClick={() => setError(null)}>{error}</p>}
            <StickerGrid 
                stickers={stickers} 
                originalFilename={originalFilename} 
                gridSize={gridSize} 
                onAddClick={() => setAddModalOpen(true)}
                onRemove={handleRemoveExpression}
                onEdit={setEditingSticker}
                onRegenerate={handleRegenerate}
            />
        </div>
      </main>
      <Footer />
    </>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);