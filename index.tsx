/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import React, { useState, ChangeEvent, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Modality } from '@google/genai';
import JSZip from 'jszip';
import './index.css';

// --- Gemini API Configuration ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- App Constants ---
const EXPRESSIONS = [
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


// --- React Components ---

const Header = () => (
  <header className="app-header">
    <h1>My Personal Stickers</h1>
  </header>
);

const StickerCreator = ({
  characterImage,
  onFileSelect,
  onGenerate,
  isLoading,
  backgroundColor,
  onBackgroundColorChange,
  transparentBackground,
  onTransparentChange,
}: {
  characterImage: string | null;
  onFileSelect: (file: File | null | undefined) => void;
  onGenerate: () => void;
  isLoading: boolean;
  backgroundColor: string;
  onBackgroundColorChange: (event: ChangeEvent<HTMLInputElement>) => void;
  transparentBackground: boolean;
  onTransparentChange: (event: ChangeEvent<HTMLInputElement>) => void;
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
                <li><span>Choose a background</span> — transparent or a solid color.</li>
                <li><span>Generate Stickers</span> and watch the AI create a unique pack!</li>
            </ol>
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


const DownloadIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
    <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
    <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
  </svg>
);


const StickerItem = ({ sticker, originalFilename }: { sticker: { imageUrl: string | null; label: string; emoji: string }, originalFilename: string | null }) => {
    const handleDownload = () => {
        if (sticker.imageUrl) {
          const prefix = originalFilename ? originalFilename.split('.').slice(0, -1).join('.') : 'sticker';
          const stickerName = sticker.label.replace(/\s+/g, '_');
          downloadImage(sticker.imageUrl, `${prefix}_${stickerName}.png`);
        }
      };

  return (
    <div className="sticker-item">
      <div className="sticker-placeholder">
        {sticker.imageUrl ? (
          <img src={sticker.imageUrl} alt={sticker.label} className="sticker-image" />
        ) : (
          <span className="sticker-emoji" role="img" aria-label={sticker.label}>{sticker.emoji}</span>
        )}
        <div className="sticker-label">
            <span>{sticker.label}</span>
            {sticker.imageUrl && (
              <button onClick={handleDownload} className="download-button" aria-label={`Download ${sticker.label} sticker`}>
                <DownloadIcon />
              </button>
            )}
          </div>
      </div>
    </div>
  );
};

const StickerGrid = ({ stickers, isLoading, originalFilename }: { stickers: any[]; isLoading: boolean; originalFilename: string | null; }) => (
  <section className={`sticker-grid ${isLoading ? 'loading' : ''}`}>
    {stickers.map((sticker) => (
      <StickerItem key={sticker.label} sticker={sticker} originalFilename={originalFilename} />
    ))}
  </section>
);

const App = () => {
  const [userImage, setUserImage] = useState<{ data: string; mimeType: string; } | null>(null);
  const [originalFilename, setOriginalFilename] = useState<string | null>(null);
  const [stickers, setStickers] = useState(
    EXPRESSIONS.map(e => ({ ...e, imageUrl: null }))
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backgroundColor, setBackgroundColor] = useState('#FFFFFF');
  const [transparentBackground, setTransparentBackground] = useState(true);

  const handleFileSelect = (file: File | null | undefined) => {
    if (file && file.type.startsWith('image/')) {
      setOriginalFilename(file.name);
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        setUserImage({
          data: dataUrl,
          mimeType: file.type,
        });
      };
      reader.readAsDataURL(file);
    } else if (file) {
      setError("Please select a valid image file (e.g., PNG, JPG, GIF).");
    }
  };

  const handleGenerate = async () => {
    if (!userImage) {
        setError("Please upload an image first!");
        return;
    }
    setIsLoading(true);
    setError(null);
    setStickers(EXPRESSIONS.map(e => ({ ...e, imageUrl: null }))); // Reset stickers

    const sourceImage = { data: dataUrlToBase64(userImage.data), mimeType: userImage.mimeType };

    const backgroundInstruction = transparentBackground
      ? 'a clean, transparent background'
      : `a solid background of the hex color ${backgroundColor}`;

    try {
      for (const expression of EXPRESSIONS) {
        const prompt = `Generate a vibrant, cartoon-style sticker of the character showing a "${expression.label}" expression. The artistic style MUST be consistent across all stickers. The sticker must have ${backgroundInstruction} and a subtle white outline. Do not use photorealistic styles or add extra background elements.`;
        
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
          const imageUrl = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
          setStickers(prevStickers =>
            prevStickers.map(s =>
              s.label === expression.label ? { ...s, imageUrl } : s
            )
          );
        } else {
            console.warn(`No image generated for: ${expression.label}`);
        }
      }
    } catch (err) {
      console.error('Error generating stickers:', err);
      setError('Sorry, something went wrong while creating the stickers. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadAll = () => {
    const zip = new JSZip();
    const generatedStickers = stickers.filter(s => s.imageUrl);

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

  return (
    <>
      <Header />
      <main>
        <StickerCreator
          characterImage={characterImage}
          onFileSelect={handleFileSelect}
          onGenerate={handleGenerate}
          isLoading={isLoading}
          backgroundColor={backgroundColor}
          onBackgroundColorChange={(e) => setBackgroundColor(e.target.value)}
          transparentBackground={transparentBackground}
          onTransparentChange={(e) => setTransparentBackground(e.target.checked)}
        />
        {error && <div className="error-message">{error}</div>}
        <hr className="divider" />
        <StickerGrid stickers={stickers} isLoading={isLoading} originalFilename={originalFilename} />
        {hasGeneratedStickers && !isLoading && (
            <div className="download-all-container">
                <button onClick={handleDownloadAll} className="download-all-button">
                Download All Stickers
                </button>
            </div>
        )}
      </main>
    </>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);