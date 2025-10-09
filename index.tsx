/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import React, { useState, ChangeEvent, useRef, useEffect, createContext, useContext, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Modality } from '@google/genai';
import JSZip from 'jszip';
import ReactCrop, { centerCrop, makeAspectCrop, type Crop, type PixelCrop } from 'react-image-crop';

import './index.css';

// --- Localization ---
type Language = 'sw' | 'en';

interface LanguageContextType {
    language: Language;
    setLanguage: (language: Language) => void;
    t: (key: string, replacements?: Record<string, string>) => string;
    isReady: boolean;
    translations: any | null;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const useLanguage = () => {
    const context = useContext(LanguageContext);
    if (!context) {
        throw new Error('useLanguage must be used within a LanguageProvider');
    }
    return context;
};

const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [language, setLanguageState] = useState<Language>(() => {
        const savedLang = localStorage.getItem('stickerMeLanguage');
        return (savedLang === 'en' || savedLang === 'sw') ? savedLang : 'sw';
    });
    const [translations, setTranslations] = useState<any | null>(null);
    const isReady = translations !== null;

    useEffect(() => {
        fetch('./translations.json')
            .then(response => response.json())
            .then(data => setTranslations(data))
            .catch(error => console.error('Error loading translations:', error));
    }, []);

    const setLanguage = (lang: Language) => {
        localStorage.setItem('stickerMeLanguage', lang);
        setLanguageState(lang);
    };

    const t = useCallback((key: string, replacements: Record<string, string> = {}) => {
        if (!translations) {
            return key;
        }
        let text = translations[language]?.[key] || translations.en?.[key] || key;
        for (const placeholder in replacements) {
            text = text.replace(`{${placeholder}}`, replacements[placeholder]);
        }
        return text;
    }, [language, translations]);

    return (
        <LanguageContext.Provider value={{ language, setLanguage, t, isReady, translations }}>
            {children}
        </LanguageContext.Provider>
    );
};


// --- Gemini API Configuration ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- App Constants ---
const POPULAR_EMOJIS = [
    '😊', '😂', '😍', '🥰', '😎', '🤔', '😉', '😋', '😜', '🤪', 
    '🤩', '🥳', '😏', '😒', '😞', '😔', '😢', '😭', '😱', '😡',
    '😠', '🤯', '🥺', '🤗', '🤫', '😬', '🙄', '🤤', '😴', '🤧',
    '😇', '🤣', '😅', '😆', '🥲', '😘', '🤨', '🧐', '🤓', '😮',
    '😲', '😳', '😨', '😥', '👍', '👎', '👌', '✌️', '👏', '🙏'
];


type StickerStatus = 'idle' | 'loading' | 'done' | 'error';
type ExpressionType = 'plain' | 'expressive';

type Expression = {
    emoji: string;
    label: string; // For default: translation key. For custom: literal text.
    type: ExpressionType;
    isDefault: boolean;
};
type Sticker = Expression & {
    imageUrl: string | null; // The final image to display/download
    originalImageUrl: string | null; // The raw image from the AI, for reprocessing
    status: StickerStatus;
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

// --- React Components ---

const LanguageSwitcher = () => {
    const { language, setLanguage, t } = useLanguage();
  
    return (
      <div className="language-switcher" role="group" aria-label="Language selection">
        <button
          onClick={() => setLanguage('en')}
          className={language === 'en' ? 'active' : ''}
          aria-pressed={language === 'en'}
          title={t('english')}
        >
          EN
        </button>
        <button
          onClick={() => setLanguage('sw')}
          className={language === 'sw' ? 'active' : ''}
          aria-pressed={language === 'sw'}
          title={t('swahili')}
        >
          SW
        </button>
      </div>
    );
};

const Header = ({ onNavigateHome }: { onNavigateHome: () => void }) => {
    const { t } = useLanguage();
    return (
        <header className="app-header">
          <button className="nav-home-btn" onClick={onNavigateHome}>{t('homeButton')}</button>
          <h1>{t('appName')}</h1>
          <LanguageSwitcher />
        </header>
    );
};

const ImageCropper = ({
    imageSrc,
    onSave,
    onCancel,
  }: {
    imageSrc: string;
    onSave: (croppedImageDataUrl: string) => void;
    onCancel: () => void;
  }) => {
    const { t } = useLanguage();
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
          <h3>{t('cropTitle')}</h3>
          <p>{t('cropInfo')}</p>
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
            <button onClick={onCancel} className="modal-button secondary">{t('cancelButton')}</button>
            <button onClick={handleCrop} className="modal-button primary">{t('cropAndUseButton')}</button>
          </div>
        </div>
      </div>
    );
  };

const StickerCreator = ({
  characterImage,
  onRequestImage,
  onGenerate,
  isLoading,
  backgroundColor,
  onBackgroundColorChange,
  transparentBackground,
  onTransparentChange,
  artisticStyle,
  onArtisticStyleChange,
  onRestoreDefaults,
}: {
  characterImage: string | null;
  onRequestImage: () => void;
  onGenerate: () => void;
  isLoading: boolean;
  backgroundColor: string;
  onBackgroundColorChange: (event: ChangeEvent<HTMLInputElement>) => void;
  transparentBackground: boolean;
  onTransparentChange: (event: ChangeEvent<HTMLInputElement>) => void;
  artisticStyle: string;
  onArtisticStyleChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onRestoreDefaults: () => void;
}) => {
  const { t } = useLanguage();
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
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
    // Note: To handle file drop, the file selection logic would need to be passed in.
    // For this refactor, we are unifying all image requests through onRequestImage.
    onRequestImage();
  };

  return (
    <div className="sticker-creator">
      <div
        className={`character-display ${isDragging ? 'drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={onRequestImage}
        role="button"
        tabIndex={0}
      >
        {characterImage ? (
            <img src={characterImage} alt="Uploaded character" className="character-image" />
        ) : (
            <div className="character-placeholder">
              <span>📷</span>
              <span className="placeholder-text">{t('uploadPlaceholder')}</span>
            </div>
        )}
      </div>
      <div className="creator-controls">
        <h2>{t('creatorTitle')}</h2>
        <div className="instructions">
            <h4>{t('creatorHowItWorks')}</h4>
            <ol>
                <li dangerouslySetInnerHTML={{ __html: t('creatorStep1') }}></li>
                <li dangerouslySetInnerHTML={{ __html: t('creatorStep2') }}></li>
                <li dangerouslySetInnerHTML={{ __html: t('creatorStep3') }}></li>
            </ol>
        </div>
        <div className="style-controls">
          <label htmlFor="artisticStyle">{t('artisticStyleLabel')}</label>
          <select id="artisticStyle" value={artisticStyle} onChange={onArtisticStyleChange}>
            <option value="Photo-realistic">{t('styleRealistic')}</option>
            <option value="Anime">{t('styleAnime')}</option>
            <option value="3D Render">{t('style3d')}</option>
          </select>
        </div>
        <div className="background-controls">
            <input
                type="checkbox"
                id="transparentBg"
                checked={transparentBackground}
                onChange={onTransparentChange}
            />
            <label htmlFor="transparentBg">{t('transparentBgLabel')}</label>
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
            <button onClick={onRequestImage} className="upload-button">
                <UploadIcon /> {characterImage ? t('changeImageButton') : t('chooseImageButton')}
            </button>
            <button onClick={onGenerate} className="generate-button" disabled={isLoading || !characterImage}>
                {isLoading ? t('generatingButton') : t('generateButton')}
            </button>
            <button onClick={onRestoreDefaults} className="restore-defaults-button" title={t('restoreDefaultsButton')}>
                <RefreshIcon />
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

const AddExpressionModal = ({ type, onAdd, onClose }: { type: ExpressionType; onAdd: (expression: {emoji: string, label: string}) => void; onClose: () => void }) => {
    const { t } = useLanguage();
    const [newEmoji, setNewEmoji] = useState(type === 'plain' ? '😀' : '');
    const [newLabel, setNewLabel] = useState('');
    const [isPickerOpen, setPickerOpen] = useState(false);
    const pickerRef = useRef<HTMLDivElement>(null);
    const modalContentRef = useRef<HTMLDivElement>(null);

    const handleAdd = (e: React.FormEvent) => {
      e.preventDefault();
      if (newLabel && (type === 'expressive' || newEmoji)) {
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
          <h3>{type === 'plain' ? t('addEmotionTitle') : t('addPhraseTitle')}</h3>
          <form onSubmit={handleAdd} className="add-expression-modal-form">
            {type === 'plain' ? (
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
                        placeholder={t('addExpressionLabelPlaceholder')}
                        className="label-input"
                        required
                        autoFocus
                    />
                </div>
            ) : (
                <>
                    <input
                        type="text"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        placeholder={t('addExpressionLabelPlaceholder')}
                        className="label-input"
                        required
                        autoFocus
                    />
                     <input
                        type="text"
                        value={newEmoji}
                        onChange={(e) => setNewEmoji(e.target.value)}
                        placeholder={t('addPhraseEmojiPlaceholder')}
                        className="label-input"
                    />
                </>
            )}
            <div className="modal-actions">
              <button type="button" onClick={onClose} className="modal-button secondary">{t('cancelButton')}</button>
              <button type="submit" className="modal-button primary">{t('addButton')}</button>
            </div>
          </form>
        </div>
      </div>
    );
  };

const TransparencyEditorModal = ({ sticker, onSave, onClose }: { sticker: Sticker; onSave: (label: string, newImageUrl: string) => void; onClose: () => void; }) => {
    const { t } = useLanguage();
    const [params, setParams] = useState<TransparencyOptions>({
        colorTol: 10,
        tileGuess: 16,
        gradKeep: 10,
        feather: 2,
    });
    const [previewUrl, setPreviewUrl] = useState(sticker.imageUrl);
    const [isProcessing, setIsProcessing] = useState(false);
    const modalContentRef = useRef<HTMLDivElement>(null);
    const displayLabel = sticker.isDefault ? t(sticker.label) : sticker.label;

    useEffect(() => {
        if (!sticker.originalImageUrl) return;

        setIsProcessing(true);
        const handler = setTimeout(() => {
            makeBackgroundTransparent(sticker.originalImageUrl!, params).then(newUrl => {
                setPreviewUrl(newUrl);
                setIsProcessing(false);
            });
        }, 300);

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
                <h3>{t('transparencyTitle')}</h3>
                <div className="editor-content">
                    <div className="editor-preview">
                        <div className="checkerboard-bg">
                            {isProcessing && <div className="preview-spinner-overlay"><div className="spinner"></div></div>}
                            <img src={previewUrl || ''} alt={`${displayLabel} preview`} />
                        </div>
                    </div>
                    <div className="editor-controls">
                        <div className="slider-control">
                            <label htmlFor="colorTol">{t('colorToleranceLabel')} ({params.colorTol})</label>
                            <input type="range" id="colorTol" min="4" max="24" value={params.colorTol} onChange={e => handleParamChange('colorTol', e.target.value)} />
                        </div>
                        <div className="slider-control">
                            <label htmlFor="tileGuess">{t('tileSizeLabel')} ({params.tileGuess})</label>
                            <input type="range" id="tileGuess" min="8" max="32" value={params.tileGuess} onChange={e => handleParamChange('tileGuess', e.target.value)} />
                        </div>
                        <div className="slider-control">
                            <label htmlFor="gradKeep">{t('textureProtectionLabel')} ({params.gradKeep})</label>
                            <input type="range" id="gradKeep" min="4" max="24" value={params.gradKeep} onChange={e => handleParamChange('gradKeep', e.target.value)} />
                        </div>
                        <div className="slider-control">
                            <label htmlFor="feather">{t('edgeFeatherLabel')} ({params.feather})</label>
                            <input type="range" id="feather" min="0" max="8" value={params.feather} onChange={e => handleParamChange('feather', e.target.value)} />
                        </div>
                    </div>
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="modal-button secondary">{t('cancelButton')}</button>
                    <button onClick={handleSave} className="modal-button primary">{t('saveChangesButton')}</button>
                </div>
            </div>
        </div>
    );
};

const CameraModal = ({ onPictureTaken, onClose }: { onPictureTaken: (imageDataUrl: string) => void; onClose: () => void; }) => {
    const { t } = useLanguage();
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const [capturedImage, setCapturedImage] = useState<string | null>(null);
    const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
    const [error, setError] = useState<string | null>(null);

    const stopStream = useCallback(() => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
    }, []);
    
    const startStream = useCallback(async () => {
        stopStream();
        setCapturedImage(null);
        setError(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
            }
        } catch (err) {
            console.error("Error accessing camera:", err);
            setError(t('errorCamera'));
        }
    }, [facingMode, stopStream, t]);

    useEffect(() => {
        startStream();
        return stopStream;
    }, [startStream, stopStream]);

    const handleTakePicture = () => {
        if (videoRef.current && canvasRef.current) {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d');
            if (context) {
                if (facingMode === 'user') {
                    context.translate(canvas.width, 0);
                    context.scale(-1, 1);
                }
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/png');
                setCapturedImage(dataUrl);
                stopStream();
            }
        }
    };

    const handleSwitchCamera = () => {
        setFacingMode(prev => (prev === 'user' ? 'environment' : 'user'));
    };

    const handleRetake = () => {
        startStream();
    };

    const handleUsePicture = () => {
        if (capturedImage) {
            onPictureTaken(capturedImage);
        }
    };
    
    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="camera-modal">
                <div className="camera-modal-header">
                    <h3>{t('cameraModalTitle')}</h3>
                </div>
                <div className="camera-feed-container">
                    {error && <p className="error-message">{error}</p>}
                    {!error && (
                        <>
                            {capturedImage ? (
                                <img src={capturedImage} alt="Captured preview" className="camera-preview" />
                            ) : (
                                <>
                                    <video ref={videoRef} autoPlay playsInline className={`camera-feed ${facingMode === 'user' ? 'mirrored' : ''}`}></video>
                                    <div className="camera-overlay">
                                        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
                                            <defs>
                                                <mask id="selfieMask">
                                                    <rect width="100" height="100" fill="white" />
                                                    <ellipse cx="50" cy="50" rx="35" ry="45" fill="black" />
                                                </mask>
                                            </defs>
                                            <rect width="100" height="100" fill="rgba(0,0,0,0.5)" mask="url(#selfieMask)" />
                                        </svg>
                                    </div>
                                </>
                            )}
                        </>
                    )}
                     <canvas ref={canvasRef} style={{ display: 'none' }}></canvas>
                </div>
                <div className="camera-controls">
                    {capturedImage ? (
                        <>
                            <button onClick={handleRetake} className="modal-button secondary">{t('retakeButton')}</button>
                            <button onClick={handleUsePicture} className="modal-button primary">{t('usePictureButton')}</button>
                        </>
                    ) : (
                        <>
                            <button onClick={onClose} className="modal-button secondary">{t('cancelButton')}</button>
                            <button onClick={handleTakePicture} className="capture-btn" title={t('takePictureButton')}></button>
                            <button onClick={handleSwitchCamera} className="switch-camera-btn" title={t('switchCameraButton')}><CameraSwitchIcon /></button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

const ImageSourceModal = ({ onSelectFile, onSelectCamera, onClose }: { onSelectFile: () => void; onSelectCamera: () => void; onClose: () => void; }) => {
    const { t } = useLanguage();
    const modalContentRef = useRef<HTMLDivElement>(null);
    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (modalContentRef.current && !modalContentRef.current.contains(e.target as Node)) {
          onClose();
        }
    };

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="modal-content" ref={modalContentRef}>
                <h3>{t('chooseSourceTitle')}</h3>
                <div className="source-modal-actions">
                    <button onClick={onSelectFile} className="source-button">
                        <UploadIcon />
                        <span>{t('sourceLibrary')}</span>
                    </button>
                    <button onClick={onSelectCamera} className="source-button">
                        <CameraIcon />
                        <span>{t('sourceCamera')}</span>
                    </button>
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="modal-button secondary">{t('cancelButton')}</button>
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

const RefreshIcon = () => (
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

const CameraIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
        <path d="M15 12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h1.172a3 3 0 0 0 2.12-.879l.83-.828A1 1 0 0 1 6.827 3h2.344a1 1 0 0 1 .707.293l.828.828A3 3 0 0 0 12.828 5H14a1 1 0 0 1 1 1zM2 4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-1.172a2 2 0 0 1-1.414-.586l-.828-.828A2 2 0 0 0 9.172 2H6.828a2 2 0 0 0-1.414.586l-.828-.828A2 2 0 0 1 3.172 4z"/>
        <path d="M8 11a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5m0 1a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M3 6.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0"/>
    </svg>
);

const UploadIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
        <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5"/>
        <path d="M7.646 1.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 2.707V11.5a.5.5 0 0 1-1 0V2.707L5.354 4.854a.5.5 0 1 1-.708-.708z"/>
    </svg>
);

const CameraSwitchIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 512 512" fill="currentColor">
        <path d="M307.81,212.18c-3.24,0-6.07-2.17-6.91-5.3l-4.82-17.88c-0.84-3.12-3.68-5.3-6.91-5.3h-21.46h-25.44H220.8     c-3.24,0-6.07-2.17-6.91,5.3l-4.82,17.88c-0.84-3.12-3.68-5.3-6.91-5.3H169.5c-3.96,0-7.16,3.21-7.16,7.16v101.78     c0,3.96,3.21,7.16,7.16,7.16h170.95c3.96,0,7.16,3.21,7.16,7.16V219.35c0-3.96-3.21-7.16-7.16-7.16H307.81z M282.33,264.94     c-0.86,13.64-11.93,24.71-25.58,25.58c-16.54,1.05-30.18-12.59-29.14-29.14c0.86-13.64,11.93-24.71,25.58-25.58     C269.74,234.76,283.38,248.4,282.33,264.94z"/>
        <path d="M82.95,272.41c3.82,0,7.53-1.53,10.23-4.23l21.23-21.23c4.74-4.74,6.4-11.92,3.73-18.06     c-2.73-6.29-8.88-8.95-18.84-7.57l-0.27,0.27c15.78-71.56,79.7-125.27,155.94-125.27c60.72,0,115.41,33.72,142.73,87.99     c3.58,7.11,12.24,9.97,19.34,6.39c7.11-3.58,9.97-12.24,6.39-19.34c-15.47-30.73-39.05-56.66-68.22-75.01     C325.23,77.47,290.57,67.5,254.98,67.5c-93,0-170.48,67.71-185.75,156.41c-5.38-4.77-13.59-5.18-19.13-0.44     c-6.3,5.39-6.75,14.88-1.13,20.84c0.23,0.24,5.69,6.03,11.41,11.93c3.41,3.51,6.2,6.33,8.3,8.38c4.23,4.13,7.88,7.69,14.07,7.78     C82.81,272.41,82.88,272.41,82.95,272.41z"/>
        <path d="M464.28,247.82l-26.5-26.5c-2.75-2.75-6.57-4.3-10.44-4.23c-2.33,0.03-4.29,0.56-6.07,1.42     c-0.26,0.12-0.51,0.26-0.76,0.4c-0.04,0.02-0.08,0.04-0.12,0.06c-0.59,0.33-1.16,0.68-1.69,1.08c-1.88,1.34-3.6,3.03-5.44,4.82     c-2.1,2.05-4.89,4.87-8.3,8.38c-5.72,5.9-11.18,11.68-11.41,11.93c-5.46,5.79-5.19,14.91,0.6,20.36     c5.75,5.42,14.77,5.18,20.24-0.48c-4.72,83.85-74.42,150.62-159.43,150.62c-70.52,0-131.86-45.23-152.62-112.55     c-2.35-7.6-10.41-11.86-18.01-9.52c-7.6,2.34-11.86,10.41-9.52,18.01c11.62,37.68,35.48,71.52,67.19,95.28     c32.8,24.59,71.86,37.58,112.96,37.58c100.11,0,182.23-78.45,188.14-177.1l0.79,0.79c2.81,2.81,6.5,4.22,10.18,4.22     c3.69,0,7.37-1.41,10.18-4.22     C469.91,262.57,469.91,253.45,464.28,247.82z"/>
    </svg>
);


const StickerItem: React.FC<{ sticker: Sticker, originalFilename: string | null, onRemove: (label: string) => void; onEdit: (sticker: Sticker) => void; onRegenerate: (label: string) => void; }> = ({ sticker, originalFilename, onRemove, onEdit, onRegenerate }) => {
    const { t } = useLanguage();
    const displayLabel = sticker.isDefault ? t(sticker.label) : sticker.label;

    const handleDownload = () => {
        if (sticker.imageUrl) {
          const prefix = originalFilename ? originalFilename.split('.').slice(0, -1).join('.') : 'sticker';
          const stickerName = displayLabel.replace(/\s+/g, '_');
          downloadImage(sticker.imageUrl, `${prefix}_${stickerName}.png`);
        }
    };
    
    const canInteract = sticker.status !== 'loading';

    const renderContent = () => {
        switch (sticker.status) {
            case 'loading':
                return <div className="spinner"></div>;
            case 'done':
                return <img src={sticker.imageUrl!} alt={displayLabel} className="sticker-image" />;
            case 'error':
                return <span className="sticker-emoji" role="img" aria-label={t('stickerError')}>⚠️</span>;
            case 'idle':
            default:
                if (sticker.type === 'expressive') {
                    return (
                        <>
                            <span className="sticker-emoji-bg" aria-hidden="true">{sticker.emoji}</span>
                            <span className="sticker-text-fg">{displayLabel}</span>
                        </>
                    );
                }
                return <span className="sticker-emoji" role="img" aria-label={displayLabel}>{sticker.emoji}</span>;
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
                        aria-label={`${t('regenerateTooltip')} ${displayLabel}`}
                        title={t('regenerateTooltip')}
                    >
                        <RefreshIcon />
                    </button>
                )}
                {sticker.status === 'done' && sticker.originalImageUrl && (
                     <button
                        className="sticker-action-btn edit-btn"
                        onClick={() => onEdit(sticker)}
                        aria-label={`${t('editTransparencyTooltip')} ${displayLabel}`}
                        title={t('editTransparencyTooltip')}
                    >
                        <EditIcon />
                    </button>
                )}
                <button
                    className="sticker-action-btn delete-btn"
                    onClick={() => onRemove(sticker.label)}
                    aria-label={`${t('deleteTooltip')} ${displayLabel}`}
                    title={`${t('deleteTooltip')} ${displayLabel}`}
                >
                    <BinIcon />
                </button>
            </div>
        )}
        <div className="sticker-placeholder">
            {renderContent()}
            <div className="sticker-label">
                <span>{displayLabel}</span>
                {sticker.imageUrl && sticker.status === 'done' && (
                <button onClick={handleDownload} className="download-button" aria-label={`${t('downloadTooltip')} ${displayLabel}`}>
                    <DownloadIcon />
                </button>
                )}
            </div>
        </div>
    </div>
    );
};

type GridSize = 'small' | 'medium' | 'large';

const StickerGrid = ({ stickers, originalFilename, gridSize, onAddClick, onRemove, onEdit, onRegenerate }: { stickers: Sticker[]; originalFilename: string | null; gridSize: GridSize; onAddClick: (type: ExpressionType) => void; onRemove: (label: string) => void; onEdit: (sticker: Sticker) => void; onRegenerate: (label: string) => void; }) => {
    const { t } = useLanguage();
    
    const plainStickers = stickers.filter(s => s.type === 'plain');
    const expressiveStickers = stickers.filter(s => s.type === 'expressive');

    const renderGridSection = (title: string, stickerList: Sticker[], type: ExpressionType) => {
        const buttonLabel = type === 'plain' ? t('addEmotionButton') : t('addExpressionButton');
        return (
            <div className="sticker-category">
                <h3 className="sticker-category-header">{title}</h3>
                <div className={`sticker-grid size-${gridSize}`}>
                    {stickerList.map(sticker => (
                        <StickerItem 
                            key={sticker.label}
                            sticker={sticker} 
                            originalFilename={originalFilename} 
                            onRemove={onRemove} 
                            onEdit={onEdit} 
                            onRegenerate={onRegenerate} 
                        />
                    ))}
                    <button className="add-sticker-btn" onClick={() => onAddClick(type)} aria-label={buttonLabel}>
                        <AddIcon />
                        <span>{buttonLabel}</span>
                    </button>
                </div>
            </div>
        );
    };

    return (
        <section>
            {renderGridSection(t('plainEmotionsHeader'), plainStickers, 'plain')}
            {renderGridSection(t('expressivePhrasesHeader'), expressiveStickers, 'expressive')}
        </section>
    );
};

const Footer = () => (
    <footer className="app-footer">
      Built with enthusiasm by Keon on AI Studio
    </footer>
  );

const ExplainerPage = ({ onNavigate }: { onNavigate: () => void; }) => {
    const { t } = useLanguage();
    const [activeStep, setActiveStep] = useState(0);
    const intervalRef = useRef<number | null>(null);
    const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

    useEffect(() => {
        const handleResize = () => setIsMobile(window.innerWidth <= 768);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const stepsData = [
        { title: 'step1Title', p: 'step1P' },
        { title: 'step2Title', p: 'step2P' },
        { title: 'step3Title', p: 'step3P' },
        { title: 'step4Title', p: 'step4P' },
    ];
    
    const stopAutoScroll = () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
    };

    const startAutoScroll = useCallback(() => {
        stopAutoScroll();
        intervalRef.current = setInterval(() => {
            setActiveStep(prev => (prev + 1) % stepsData.length);
        }, 2000); // 2 seconds per step
    }, [stepsData.length]);

    useEffect(() => {
        startAutoScroll();
        return () => stopAutoScroll();
    }, [startAutoScroll]);

    const handleMarkerClick = (index: number) => {
        setActiveStep(index);
        startAutoScroll(); // Reset the timer when user interacts
    };

    const transformStyle = isMobile ? { transform: `translateX(-${activeStep * 100}%)` } : {};

    return (
        <div className="explainer-page">
            <header className="app-header explainer-header">
                <LanguageSwitcher />
                <h1>{t('explainerWelcome')}</h1>
                <p className="header-subtitle">{t('explainerSubtitle')}</p>
            </header>
            <main className="explainer-content">
            <section className="explainer-intro">
                <h2>{t('explainerIntroTitle')}</h2>
                <p>{t('explainerIntroP')}</p>
                <button className="get-started-btn" onClick={onNavigate}>
                {t('getStartedButton')}
                </button>
            </section>

            <section className="how-it-works">
                <h2>{t('howItWorksTitle')}</h2>
                <div
                    className="carousel-wrapper"
                    onMouseEnter={stopAutoScroll}
                    onMouseLeave={startAutoScroll}
                >
                    <div className="steps-container" style={transformStyle}>
                        {stepsData.map((step, index) => (
                            <div key={step.title} className={`step-card ${index === activeStep ? 'active' : ''}`}>
                                <div className="step-icon">{index + 1}</div>
                                <h3>{t(step.title)}</h3>
                                <p>{t(step.p)}</p>
                            </div>
                        ))}
                    </div>
                    <div className="carousel-markers">
                        {stepsData.map((_, index) => (
                            <button
                                key={index}
                                className={`marker ${index === activeStep ? 'active' : ''}`}
                                onClick={() => handleMarkerClick(index)}
                                aria-label={`Go to step ${index + 1}`}
                            />
                        ))}
                    </div>
                </div>
            </section>

            <section className="features">
                <h2>{t('featuresTitle')}</h2>
                <ul>
                    <li dangerouslySetInnerHTML={{ __html: t('featureAI') }}></li>
                    <li dangerouslySetInnerHTML={{ __html: t('featureStyles') }}></li>
                    <li dangerouslySetInnerHTML={{ __html: t('featureCrop') }}></li>
                    <li dangerouslySetInnerHTML={{ __html: t('featureTransparency') }}></li>
                    <li dangerouslySetInnerHTML={{ __html: t('featureCustomize') }}></li>
                    <li dangerouslySetInnerHTML={{ __html: t('featureSave') }}></li>
                    <li dangerouslySetInnerHTML={{ __html: t('featureBulk') }}></li>
                </ul>
            </section>
            </main>
            <Footer />
        </div>
    );
};

const StickerAppPage = ({ onNavigateHome }: { onNavigateHome: () => void }) => {
  const { t, isReady, translations } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getInitialExpressions = useCallback((): Expression[] => [
    { emoji: '👍', label: 'expThumbsUp', type: 'plain', isDefault: true },
    { emoji: '😏', label: 'expCheekySmile', type: 'plain', isDefault: true },
    { emoji: '😉', label: 'expNaughtyWink', type: 'plain', isDefault: true },
    { emoji: '😎', label: 'expCoolShades', type: 'plain', isDefault: true },
    { emoji: '👏', label: 'expSlowClap', type: 'plain', isDefault: true },
    { emoji: '😔', label: 'expSadSigh', type: 'plain', isDefault: true },
    { emoji: '🤦', label: 'expFacepalm', type: 'plain', isDefault: true },
    { emoji: '☹️', label: 'expFrown', type: 'plain', isDefault: true },
    { emoji: '😋', label: 'expTongueOut', type: 'plain', isDefault: true },
    { emoji: '🤔', label: 'expCuriousThinking', type: 'plain', isDefault: true },
    { emoji: '👌', label: 'expPhrasePoapoa', type: 'expressive', isDefault: true },
    { emoji: '🧐', label: 'expPhraseNaijuaHiyo', type: 'expressive', isDefault: true },
    { emoji: '🙅', label: 'expPhraseAchaKabisa', type: 'expressive', isDefault: true },
    { emoji: '🙅‍♀️', label: 'expPhraseNoThanks', type: 'expressive', isDefault: true },
    { emoji: '🙏', label: 'expPhraseAhsanteSana', type: 'expressive', isDefault: true },
    { emoji: '⁉️', label: 'expPhraseAaah', type: 'expressive', isDefault: true },
    { emoji: '✅', label: 'expPhraseYeeap', type: 'expressive', isDefault: true },
    { emoji: '🤗', label: 'expPhraseUsiogope', type: 'expressive', isDefault: true },
    { emoji: '🤥', label: 'expPhraseUwongo', type: 'expressive', isDefault: true },
    { emoji: '🙄', label: 'expPhraseKausha', type: 'expressive', isDefault: true },
  ], []);

  const [expressions, setExpressions] = useState<Expression[]>([]);
  const [userImage, setUserImage] = useState<{ data: string; mimeType: string; } | null>(null);
  const [originalFilename, setOriginalFilename] = useState<string | null>(null);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backgroundColor, setBackgroundColor] = useState('#FFFFFF');
  const [transparentBackground, setTransparentBackground] = useState(true);
  const [imageToCrop, setImageToCrop] = useState<string | null>(null);
  const [isCropModalOpen, setCropModalOpen] = useState(false);
  const [isCameraModalOpen, setCameraModalOpen] = useState(false);
  const [isSourceModalOpen, setSourceModalOpen] = useState(false);
  const [artisticStyle, setArtisticStyle] = useState('Photo-realistic');
  const [gridSize, setGridSize] = useState<GridSize>('medium');
  const [expressionTypeToAdd, setExpressionTypeToAdd] = useState<ExpressionType | null>(null);
  const [editingSticker, setEditingSticker] = useState<Sticker | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const LOCAL_STORAGE_KEY = 'stickerMeSession';

  // Load state from localStorage once translations are ready
  useEffect(() => {
    if (!isReady || isInitialized) {
        return;
    }

    try {
      const savedStateJSON = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (savedStateJSON) {
        const savedState = JSON.parse(savedStateJSON);
        if (savedState.expressions && Array.isArray(savedState.expressions)) {
          setExpressions(savedState.expressions);
        } else {
          setExpressions(getInitialExpressions());
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
      } else {
        setExpressions(getInitialExpressions());
      }
    } catch (e) {
      console.error("Failed to load state from localStorage", e);
      localStorage.removeItem(LOCAL_STORAGE_KEY);
      setExpressions(getInitialExpressions());
    } finally {
      setIsInitialized(true);
    }
  }, [isReady, isInitialized, getInitialExpressions]);

  // Save state to localStorage whenever settings or expressions change
  useEffect(() => {
    if (!isInitialized) {
      return;
    }
    try {
      const sessionData = {
        expressions,
        originalFilename,
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
    setStickers(prevStickers => {
      const newStickers = expressions.map(exp => {
        const existingSticker = prevStickers.find(s => s.label === exp.label);
        return existingSticker || { ...exp, imageUrl: null, originalImageUrl: null, status: 'idle' as const };
      });
      return newStickers.filter(s => expressions.some(e => e.label === s.label));
    });
  }, [expressions]);

  const handleAddExpression = (newExpression: { emoji: string; label: string }, type: ExpressionType) => {
    if (!expressions.some(e => e.label.toLowerCase() === newExpression.label.toLowerCase())) {
        const finalEmoji = type === 'expressive' && !newExpression.emoji ? '💬' : newExpression.emoji;
        const expressionToAdd: Expression = { ...newExpression, emoji: finalEmoji, type, isDefault: false };
        setExpressions(prev => [...prev, expressionToAdd]);
        setError(null);
    } else {
        setError(t('errorExpressionExists', { label: newExpression.label }));
    }
    setExpressionTypeToAdd(null);
  };

  const handleRemoveExpression = (labelToRemove: string) => {
    setExpressions(prev => prev.filter(e => e.label !== labelToRemove));
  };

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      setOriginalFilename(file.name);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImageToCrop(reader.result as string);
        setCropModalOpen(true);
      };
      reader.readAsDataURL(file);
    } else if (file) {
      setError(t('errorInvalidFile'));
    }
  };

  const handlePictureTaken = (imageDataUrl: string) => {
    setCameraModalOpen(false);
    setOriginalFilename(`sticker-me-shot-${Date.now()}.png`);
    setImageToCrop(imageDataUrl);
    setCropModalOpen(true);
  };

  const handleCropSave = (croppedImageDataUrl: string) => {
    setUserImage({
      data: croppedImageDataUrl,
      mimeType: 'image/png',
    });
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


  const generateSticker = async (expression: Expression) => {
    if (!userImage) return; // Should be checked before calling

    setStickers(prev => prev.map(s => s.label === expression.label ? { ...s, status: 'loading' as const } : s));
    
    const sourceImage = { data: dataUrlToBase64(userImage.data), mimeType: userImage.mimeType };
    
    const backgroundInstruction = transparentBackground
      ? 'a transparent background. The output image must be a PNG with a true alpha channel, not a rendered checkerboard pattern representing transparency.'
      : `a solid, opaque background of the hex color ${backgroundColor}`;

    let styleInstruction = '';
    switch (artisticStyle) {
        case 'Anime': styleInstruction = 'a vibrant Anime/Manga style'; break;
        case '3D Render': styleInstruction = 'a polished 3D render style, similar to modern animated films'; break;
        case 'Photo-realistic': default: styleInstruction = 'a photo-realistic style, making it look like a real high-resolution photograph'; break;
    }

    let specificInstruction = '';
    if (expression.type === 'plain') {
        specificInstruction = 'Create a clean, simple, close-up sticker focusing on the facial expression of the character. The character should be shown from the chest up.';
    } else { // expressive
        specificInstruction = 'Create a high-energy, meme-style sticker. The character can have exaggerated features or be in a more dynamic pose to match the phrase. Feel free to add subtle, non-distracting graphic elements like motion lines or sparkles if it enhances the expression.';
    }
    
    const getEnglishLabel = (exp: Expression) => {
        if (!exp.isDefault) {
            return exp.label; // Custom labels are literal strings
        }
        // For default expressions, get the English translation from the key
        return translations?.en?.[exp.label] || exp.label; // Fallback to key if not found
    };
    const englishLabel = getEnglishLabel(expression);

    try {
        const prompt = `Generate a high-quality sticker of the character showing a "${englishLabel}" expression. ${specificInstruction} The artistic style MUST be ${styleInstruction}. The sticker must have ${backgroundInstruction} and a subtle, dark grey outline around the subject. The final output must be a PNG file. Ensure the style is consistent across all stickers. Do not add extra background elements or text.`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts: [{ inlineData: sourceImage }, { text: prompt }] },
            config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
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
            setStickers(prev => prev.map(s => s.label === expression.label ? { ...s, imageUrl: processedImageUrl, originalImageUrl, status: 'done' as const } : s));
        } else {
            console.warn(`No image generated for: ${expression.label}`);
            setStickers(prev => prev.map(s => s.label === expression.label ? { ...s, status: 'error' as const } : s));
        }
    } catch(err) {
        console.error(`Error generating sticker for ${expression.label}:`, err);
        setStickers(prev => prev.map(s => s.label === expression.label ? { ...s, status: 'error' as const } : s));
    }
  };

  const handleGenerate = async () => {
    if (!userImage) { setError(t('errorUploadFirst')); return; }
    if (expressions.length === 0) { setError(t('errorNeedExpression')); return; }
    
    setIsLoading(true);
    setError(null);
    setStickers(expressions.map(e => ({ ...e, imageUrl: null, originalImageUrl: null, status: 'idle' as const })));

    try {
      for (const expression of expressions) {
        await generateSticker(expression);
      }
    } catch (err) {
      console.error('Error during generation process:', err);
      setError(t('errorMajor'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegenerate = async (label: string) => {
    if (!userImage) { setError(t('errorUploadFirst')); return; }

    const expression = expressions.find(e => e.label === label);
    if (!expression) { console.error("Expression not found for regeneration:", label); return; }

    setError(null);
    await generateSticker(expression);
  };

  const handleDownloadAll = () => {
    const zip = new JSZip();
    const generatedStickers = stickers.filter(s => s.imageUrl && s.status === 'done');

    if (generatedStickers.length === 0) return;

    const prefix = originalFilename ? originalFilename.split('.').slice(0, -1).join('.') : 'my';

    generatedStickers.forEach(sticker => {
      const displayLabel = sticker.isDefault ? t(sticker.label) : sticker.label;
      const base64Data = dataUrlToBase64(sticker.imageUrl!);
      const filename = `${prefix}_${displayLabel.replace(/\s+/g, '_')}.png`;
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

  const handleRestoreDefaults = () => {
    if (window.confirm(t('confirmRestore'))) {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
      
      const defaults = getInitialExpressions();
      setExpressions(defaults);
      setStickers(defaults.map(e => ({ ...e, imageUrl: null, originalImageUrl: null, status: 'idle' as const })));

      setUserImage(null);
      setOriginalFilename(null);
      setIsLoading(false);
      setError(null);
      setBackgroundColor('#FFFFFF');
      setTransparentBackground(true);
      setImageToCrop(null);
      setCropModalOpen(false);
      setArtisticStyle('Photo-realistic');
      setGridSize('medium');
      setExpressionTypeToAdd(null);
      setEditingSticker(null);
    }
  };

  const characterImage = userImage?.data || null;
  const hasGeneratedStickers = stickers.some(s => s.imageUrl);
  const hasGenerationStarted = stickers.some(s => s.status !== 'idle');

  return (
    <>
      <Header onNavigateHome={onNavigateHome} />
      <main>
        <input
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            onClick={(e: React.MouseEvent<HTMLInputElement>) => {
              e.currentTarget.value = '';
            }}
            style={{ display: 'none' }}
            ref={fileInputRef}
        />
        {isCropModalOpen && imageToCrop && (
          <ImageCropper
            imageSrc={imageToCrop}
            onSave={handleCropSave}
            onCancel={handleCropCancel}
          />
        )}
        {isCameraModalOpen && (
            <CameraModal 
                onPictureTaken={handlePictureTaken}
                onClose={() => setCameraModalOpen(false)}
            />
        )}
        {isSourceModalOpen && (
            <ImageSourceModal 
                onSelectFile={() => {
                    setSourceModalOpen(false);
                    fileInputRef.current?.click();
                }}
                onSelectCamera={() => {
                    setSourceModalOpen(false);
                    setCameraModalOpen(true);
                }}
                onClose={() => setSourceModalOpen(false)}
            />
        )}
        {expressionTypeToAdd && (
            <AddExpressionModal
                type={expressionTypeToAdd}
                onAdd={(newExp) => handleAddExpression(newExp, expressionTypeToAdd)}
                onClose={() => setExpressionTypeToAdd(null)}
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
          onRequestImage={() => setSourceModalOpen(true)}
          onGenerate={handleGenerate}
          isLoading={isLoading}
          backgroundColor={backgroundColor}
          onBackgroundColorChange={(e) => setBackgroundColor(e.target.value)}
          transparentBackground={transparentBackground}
          onTransparentChange={(e) => setTransparentBackground(e.target.checked)}
          artisticStyle={artisticStyle}
          onArtisticStyleChange={(e) => setArtisticStyle(e.target.value)}
          onRestoreDefaults={handleRestoreDefaults}
        />

        {error && <p className="error-message" onClick={() => setError(null)}>{error}</p>}
        
        {hasGenerationStarted && (
        <div className="generation-results">
            <div className="results-header">
                <div className="results-header-info">
                    <h2>{t('resultsTitle')}</h2>
                    <p>{t('resultsInfo')}</p>
                </div>
                <div className="display-size-toggler">
                    <span>{t('viewSizeLabel')}</span>
                    <button className={`size-toggle-btn ${gridSize === 'small' ? 'active' : ''}`} onClick={() => setGridSize('small')} title={t('viewSizeSmall')}>S</button>
                    <button className={`size-toggle-btn ${gridSize === 'medium' ? 'active' : ''}`} onClick={() => setGridSize('medium')} title={t('viewSizeMedium')}>M</button>
                    <button className={`size-toggle-btn ${gridSize === 'large' ? 'active' : ''}`} onClick={() => setGridSize('large')} title={t('viewSizeLarge')}>L</button>
                </div>
                <button 
                    className="download-all-button" 
                    onClick={handleDownloadAll}
                    disabled={!hasGeneratedStickers}
                >
                    <DownloadIcon />
                    {t('downloadAllButton')}
                </button>
            </div>
        </div>
        )}

        <StickerGrid 
          stickers={stickers} 
          originalFilename={originalFilename} 
          gridSize={gridSize}
          onAddClick={(type) => setExpressionTypeToAdd(type)}
          onRemove={handleRemoveExpression} 
          onEdit={setEditingSticker}
          onRegenerate={handleRegenerate}
        />

      </main>
      <Footer />
    </>
  );
};

const App = () => {
    const [page, setPage] = useState<'explainer' | 'app'>('explainer');

    useEffect(() => {
        // Simple routing based on a hash, could be expanded.
        if (window.location.hash === '#create') {
            setPage('app');
        }
    }, []);

    const navigateToApp = () => {
        setPage('app');
        window.location.hash = '#create';
    };
    
    const navigateToHome = () => {
        setPage('explainer');
        window.location.hash = '';
    }

    return (
        <LanguageProvider>
            {page === 'explainer' ? (
                <ExplainerPage onNavigate={navigateToApp} />
            ) : (
                <StickerAppPage onNavigateHome={navigateToHome}/>
            )}
        </LanguageProvider>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);