/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import React, { useState, ChangeEvent, useRef, useEffect, createContext, useContext, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Modality } from '@google/genai';
import JSZip from 'jszip';
import ReactCrop, { centerCrop, makeAspectCrop, type Crop, type PixelCrop } from 'react-image-crop';

import { 
    Language, ExpressionType, Expression, Sticker, TransparencyOptions, GridSize, TransparencySeed 
} from './types';
import { 
    DownloadIcon, BinIcon, EditIcon, RefreshIcon, AddIcon, CameraIcon, 
    UploadIcon, CameraSwitchIcon, PauseIcon, PlayIcon
} from './components/Icons';
import { makeBackgroundTransparent } from './utils/transparency';
import { generatePrompt } from './utils/prompt-generator';
import { normalizeImageSize, MAX_STICKER_DIMENSION, dataUrlToBlob } from './utils/image';

import './index.css';

type HeroFrameSource = {
    id: string;
    labelKey: string;
    fallbackLabel: string;
    file: string;
};

type HeroFrame = HeroFrameSource & {
    url: string;
};

const HERO_SOURCE_FILES: HeroFrameSource[] = [
    { id: 'model0', labelKey: 'heroOriginalCaption', fallbackLabel: 'Original upload', file: 'Model_0.png' },
    { id: 'model1', labelKey: 'heroVariantHappy', fallbackLabel: 'Happy sticker', file: 'Model_1.png' },
    { id: 'model2', labelKey: 'heroVariantSurprised', fallbackLabel: 'Surprised sticker', file: 'Model_2.png' },
    { id: 'model3', labelKey: 'heroVariantCool', fallbackLabel: 'Cool sticker', file: 'Model_3.png' },
    { id: 'model4', labelKey: 'heroVariantLaugh', fallbackLabel: 'Laughing sticker', file: 'Model_4.png' },
    { id: 'model5', labelKey: 'heroVariantFocused', fallbackLabel: 'Focused sticker', file: 'Model_5.png' },
    { id: 'model6', labelKey: 'heroVariantDreamy', fallbackLabel: 'Dreamy sticker', file: 'Model_6.png' },
];

// --- Localization ---
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
        {/* FIX: Corrected typo in LanguageContext.Provider closing tag. */}
        </LanguageContext.Provider>
    );
};

// --- Asset Context ---
interface AssetContextType {
    model0Url: string;
    heroFrames: HeroFrame[];
}

const AssetContext = createContext<AssetContextType | undefined>(undefined);

const useAssets = () => {
    const context = useContext(AssetContext);
    if (!context) {
        throw new Error('useAssets must be used within an AssetProvider');
    }
    return context;
};

const AssetProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [model0Url, setModel0Url] = useState('');
    const [heroFrames, setHeroFrames] = useState<HeroFrame[]>([]);

    useEffect(() => {
        const objectUrls: string[] = [];
        let cancelled = false;

        const loadAssets = async () => {
            try {
                const loadedFrames = await Promise.all(
                    HERO_SOURCE_FILES.map(async (source) => {
                        const response = await fetch(`./assets/${source.file}`);
                        if (!response.ok) {
                            throw new Error(`Failed to load ${source.file}`);
                        }
                        const blob = await response.blob();
                        const objectUrl = URL.createObjectURL(blob);
                        objectUrls.push(objectUrl);
                        return { ...source, url: objectUrl };
                    })
                );

                if (!cancelled) {
                    setHeroFrames(loadedFrames);
                    setModel0Url(loadedFrames[0]?.url ?? '');
                }
            } catch (error) {
                console.error('Failed to load hero showcase assets', error);
            }
        };

        loadAssets();

        return () => {
            cancelled = true;
            objectUrls.forEach((url) => URL.revokeObjectURL(url));
        };
    }, []);

    return (
        <AssetContext.Provider value={{ model0Url, heroFrames }}>
            {children}
        </AssetContext.Provider>
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

const DEFAULT_TRANSPARENCY_OPTIONS: TransparencyOptions = {
    colorTol: 10,
    tileGuess: 16,
    gradKeep: 10,
    feather: 2,
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
          const { dataUrl } = await normalizeImageSize(base64Image, MAX_STICKER_DIMENSION);
          onSave(dataUrl);
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
    const [seedPoints, setSeedPoints] = useState<TransparencySeed[]>([]);
    const [previewUrl, setPreviewUrl] = useState(sticker.imageUrl);
    const [isProcessing, setIsProcessing] = useState(false);
    const [imageDims, setImageDims] = useState<{ width: number; height: number } | null>(null);
    const modalContentRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const displayLabel = sticker.isDefault ? t(sticker.label) : sticker.label;

    useEffect(() => {
        setSeedPoints([]);
        setPreviewUrl(sticker.imageUrl);
        setImageDims(null);
    }, [sticker.imageUrl, sticker.originalImageUrl, sticker.label]);

    useEffect(() => {
        if (!sticker.originalImageUrl) {
            setIsProcessing(false);
            return;
        }
        let cancelled = false;
        setIsProcessing(true);
        const timer = window.setTimeout(() => {
            makeBackgroundTransparent(sticker.originalImageUrl!, {
                ...DEFAULT_TRANSPARENCY_OPTIONS,
                seedPoints,
                mode: seedPoints.length ? 'auto+seed' : 'auto',
                maxDimension: MAX_STICKER_DIMENSION,
            }).then(newUrl => {
                if (!cancelled) {
                    setPreviewUrl(newUrl);
                    setIsProcessing(false);
                }
            }).catch(error => {
                console.error('Error refining transparency:', error);
                if (!cancelled) {
                    setPreviewUrl(sticker.originalImageUrl!);
                    setIsProcessing(false);
                }
            });
        }, 150);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [seedPoints, sticker.originalImageUrl]);

    const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
        const target = event.currentTarget;
        setImageDims({
            width: target.naturalWidth,
            height: target.naturalHeight,
        });
    };

    const handlePreviewClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (isProcessing || !imgRef.current || !sticker.originalImageUrl) {
            return;
        }
        const imgRect = imgRef.current.getBoundingClientRect();
        if (
            event.clientX < imgRect.left ||
            event.clientX > imgRect.right ||
            event.clientY < imgRect.top ||
            event.clientY > imgRect.bottom
        ) {
            return;
        }
        const relativeX = (event.clientX - imgRect.left) / imgRect.width;
        const relativeY = (event.clientY - imgRect.top) / imgRect.height;
        const x = relativeX * imgRef.current.naturalWidth;
        const y = relativeY * imgRef.current.naturalHeight;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        setSeedPoints(prev => [...prev, { x, y, force: true }]);
    };

    const handleUndo = () => {
        setSeedPoints(prev => prev.slice(0, -1));
    };

    const handleResetSeeds = () => {
        setSeedPoints([]);
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

    const seedStatus = seedPoints.length
        ? t('transparencySeedCount', { count: seedPoints.length.toString() })
        : t('transparencySeedNone');

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="transparency-editor-modal" ref={modalContentRef}>
                <h3>{t('transparencyTitle')}</h3>
                <div className="editor-content">
                    <div className="editor-preview">
                        <div className="checkerboard-bg pick-mode" onClick={handlePreviewClick}>
                            {isProcessing && <div className="preview-spinner-overlay"><div className="spinner"></div></div>}
                            {previewUrl && (
                                <>
                                    <img
                                        ref={imgRef}
                                        src={previewUrl}
                                        alt={`${displayLabel} preview`}
                                        onLoad={handleImageLoad}
                                    />
                                    {imageDims && seedPoints.map((seed, index) => (
                                        <span
                                            key={`${seed.x}-${seed.y}-${index}`}
                                            className="seed-marker"
                                            style={{
                                                left: `${(seed.x / imageDims.width) * 100}%`,
                                                top: `${(seed.y / imageDims.height) * 100}%`,
                                            }}
                                        />
                                    ))}
                                </>
                            )}
                        </div>
                    </div>
                    <div className="editor-controls">
                        <p className="picker-description">{t('transparencyPickerInstructions')}</p>
                        <p className="picker-status">{seedStatus}</p>
                        <div className="picker-actions">
                            <button type="button" className="picker-button" onClick={handleUndo} disabled={!seedPoints.length}>
                                {t('transparencyUndo')}
                            </button>
                            <button type="button" className="picker-button" onClick={handleResetSeeds} disabled={!seedPoints.length}>
                                {t('transparencyReset')}
                            </button>
                        </div>
                        <p className="picker-hint">{t('transparencyPickerHint')}</p>
                    </div>
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="modal-button secondary">{t('cancelButton')}</button>
                    <button onClick={handleSave} className="modal-button primary" disabled={isProcessing}>{t('saveChangesButton')}</button>
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

const Footer = () => {
    return (
        <footer className="app-footer">
          <span>Built with enthusiasm by Keon on AI Studio</span>
        </footer>
    );
};

const ExplainerPage = ({ onNavigate }: { onNavigate: () => void; }) => {
    const { t } = useLanguage();
    const { model0Url, heroFrames } = useAssets();
    const [activeStep, setActiveStep] = useState(0);
    // Fix: Use ReturnType<typeof setInterval> to correctly type the ref for both browser (number) and Node.js (Timeout) environments.
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
    const [isManuallyPaused, setIsManuallyPaused] = useState(false);

    useEffect(() => {
        const handleResize = () => setIsMobile(window.innerWidth <= 768);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const heroSequence = useMemo<HeroFrame[]>(() => {
        if (heroFrames.length) {
            return heroFrames;
        }
        if (model0Url) {
            const baseSource = HERO_SOURCE_FILES[0];
            return [{ ...baseSource, url: model0Url }];
        }
        return [];
    }, [heroFrames, model0Url]);

    const [activeHeroFrame, setActiveHeroFrame] = useState(0);
    const heroSequenceLength = heroSequence.length;

    useEffect(() => {
        setActiveHeroFrame(0);
    }, [heroSequenceLength]);

    useEffect(() => {
        if (heroSequenceLength <= 1) {
            return;
        }
        const id = window.setInterval(() => {
            setActiveHeroFrame(prev => (prev + 1) % heroSequenceLength);
        }, 3600);
        return () => window.clearInterval(id);
    }, [heroSequenceLength]);

    const getHeroLabel = useCallback((frame?: HeroFrame) => {
        if (!frame) {
            return t('heroLoading');
        }
        const localized = t(frame.labelKey);
        return localized !== frame.labelKey ? localized : frame.fallbackLabel;
    }, [t]);

    const stepsData = useMemo(() => {
        const fallbackFrame = heroSequence[0];
        const stepFrames: (HeroFrame | undefined)[] = [
            heroSequence[0] ?? fallbackFrame,
            heroSequence[1] ?? heroSequence[0] ?? fallbackFrame,
            heroSequence[2] ?? heroSequence[1] ?? heroSequence[0] ?? fallbackFrame,
            heroSequence[3] ?? heroSequence[2] ?? heroSequence[1] ?? heroSequence[0] ?? fallbackFrame,
        ];
        return [
            { title: 'step1Title', p: 'step1P', frame: stepFrames[0] },
            { title: 'step2Title', p: 'step2P', frame: stepFrames[1] },
            { title: 'step3Title', p: 'step3P', frame: stepFrames[2] },
            { title: 'step4Title', p: 'step4P', frame: stepFrames[3] },
        ];
    }, [heroSequence]);

    const heroCaption = heroSequence.length ? getHeroLabel(heroSequence[activeHeroFrame]) : t('heroLoading');
    const totalSteps = stepsData.length;

    const stopAutoScroll = () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
    };

    const startAutoScroll = useCallback(() => {
        stopAutoScroll();
        intervalRef.current = setInterval(() => {
            setActiveStep(prev => (prev + 1) % totalSteps);
        }, 2000); // 2 seconds per step
    }, [totalSteps]);

    useEffect(() => {
        if (!isManuallyPaused) {
            startAutoScroll();
        } else {
            stopAutoScroll();
        }
        return () => stopAutoScroll();
    }, [startAutoScroll, isManuallyPaused]);

    const handleMarkerClick = (index: number) => {
        setActiveStep(index);
        if (!isManuallyPaused) {
            startAutoScroll(); // Reset the timer when user interacts
        }
    };
    
    const handleTogglePause = () => {
        setIsManuallyPaused(prev => !prev);
    };
    
    const handleMouseEnter = () => {
        if (!isManuallyPaused) {
            stopAutoScroll();
        }
    };
    
    const handleMouseLeave = () => {
        if (!isManuallyPaused) {
            startAutoScroll();
        }
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
                <div className="intro-content-wrapper">
                    <div className="intro-text">
                        <h2>{t('explainerIntroTitle')}</h2>
                        <p>{t('explainerIntroP')}</p>
                        <button className="get-started-btn" onClick={onNavigate}>
                            {t('getStartedButton')}
                        </button>
                    </div>
                    <div className="intro-image-container">
                        <div className="hero-showcase">
                            <div className="sticker-burst">
                                {heroSequence.slice(1, 4).map((frame, index) => (
                                    <img
                                        key={`burst-${frame.id}`}
                                        src={frame.url}
                                        alt={getHeroLabel(frame)}
                                        className={`burst-frame burst-frame-${index}`}
                                    />
                                ))}
                            </div>
                            {heroSequence.map((frame, index) => (
                                <img
                                    key={frame.id}
                                    src={frame.url}
                                    alt={getHeroLabel(frame)}
                                    className={`hero-frame ${index === activeHeroFrame ? 'is-active' : ''}`}
                                />
                            ))}
                            {!heroSequence.length && (
                                <div className="hero-placeholder">
                                    <div className="spinner"></div>
                                </div>
                            )}
                            {heroSequence.length > 0 && (
                                <div className="hero-caption">{heroCaption}</div>
                            )}
                        </div>
                    </div>
                </div>
            </section>

            <section className="how-it-works">
                <h2>{t('howItWorksTitle')}</h2>
                <div
                    className="carousel-wrapper"
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                >
                    <div className="steps-container" style={transformStyle}>
                        {stepsData.map((step, index) => (
                            <div key={step.title} className={`step-card ${index === activeStep ? 'active' : ''}`}>
                                <div className="step-icon">{index + 1}</div>
                                <h3>{t(step.title)}</h3>
                                {step.frame && (
                                    <img
                                        src={step.frame.url}
                                        alt={getHeroLabel(step.frame)}
                                        className="step-image-preview"
                                    />
                                )}
                                <p>{t(step.p)}</p>
                            </div>
                        ))}
                    </div>
                    <div className="carousel-controls-container">
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
                        <button 
                            className="play-pause-btn"
                            onClick={handleTogglePause}
                            aria-label={isManuallyPaused ? "Play carousel" : "Pause carousel"}
                        >
                            {isManuallyPaused ? <PlayIcon /> : <PauseIcon />}
                        </button>
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

  // Handle pasting images from clipboard
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items) return;

        let imageFile: File | null = null;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                imageFile = item.getAsFile();
                break;
            }
        }

        if (imageFile) {
            event.preventDefault();

            const reader = new FileReader();
            reader.onloadend = () => {
                const imageDataUrl = reader.result as string;
                if (imageDataUrl) {
                    setOriginalFilename(`pasted-image-${Date.now()}.png`);
                    setImageToCrop(imageDataUrl);
                    setCropModalOpen(true);
                    setSourceModalOpen(false); // Close modal if open
                }
            };
            reader.readAsDataURL(imageFile);
        }
    };

    document.addEventListener('paste', handlePaste);
    return () => {
        document.removeEventListener('paste', handlePaste);
    };
  }, []);

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
    
    try {
        const prompt = generatePrompt(expression, artisticStyle, transparentBackground, backgroundColor, translations);
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts: [{ inlineData: sourceImage }, { text: prompt }] },
            config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
        });
        
        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            const baseMime = imagePart.inlineData.mimeType || 'image/png';
            const rawImageUrl = `data:${baseMime};base64,${imagePart.inlineData.data}`;
            const { dataUrl: constrainedOriginal } = await normalizeImageSize(rawImageUrl, MAX_STICKER_DIMENSION);
            let processedImageUrl = constrainedOriginal;

            if (transparentBackground) {
                try {
                    processedImageUrl = await makeBackgroundTransparent(constrainedOriginal, {
                        ...DEFAULT_TRANSPARENCY_OPTIONS,
                        maxDimension: MAX_STICKER_DIMENSION,
                    });
                } catch (processError) {
                    console.warn(`Could not process image for transparency, falling back to original.`, processError);
                }
            }
            setStickers(prev => prev.map(s => s.label === expression.label ? { ...s, imageUrl: processedImageUrl, originalImageUrl: constrainedOriginal, status: 'done' as const } : s));
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
      const filename = `${prefix}_${displayLabel.replace(/\s+/g, '_')}.png`;
      const blob = dataUrlToBlob(sticker.imageUrl!);
      zip.file(filename, blob);
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
    if (!window.confirm(t('confirmRestore'))) {
      return;
    }

    localStorage.removeItem(LOCAL_STORAGE_KEY);

    const defaults = getInitialExpressions();
    setExpressions(defaults);
    setStickers(prev => {
      prev.forEach(sticker => {
        if (sticker.imageUrl && sticker.imageUrl.startsWith('blob:')) {
          URL.revokeObjectURL(sticker.imageUrl);
        }
        if (sticker.originalImageUrl && sticker.originalImageUrl.startsWith('blob:')) {
          URL.revokeObjectURL(sticker.originalImageUrl);
        }
      });
      return defaults.map(e => ({ ...e, imageUrl: null, originalImageUrl: null, status: 'idle' as const }));
    });

    setUserImage(null);
    setOriginalFilename(null);
    setIsLoading(false);
    setError(null);
    setBackgroundColor('#FFFFFF');
    setTransparentBackground(true);
    setImageToCrop(null);
    setArtisticStyle('Photo-realistic');
    setGridSize('medium');
    setExpressionTypeToAdd(null);
    setEditingSticker(null);
    setCropModalOpen(false);
    setCameraModalOpen(false);
    setSourceModalOpen(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
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
            <AssetProvider>
                {page === 'explainer' ? (
                    <ExplainerPage onNavigate={navigateToApp} />
                ) : (
                    <StickerAppPage onNavigateHome={navigateToHome}/>
                )}
            </AssetProvider>
        </LanguageProvider>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
