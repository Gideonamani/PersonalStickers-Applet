export type Language = 'sw' | 'en';

export type StickerStatus = 'idle' | 'loading' | 'done' | 'error';
export type ExpressionType = 'plain' | 'expressive';

export type Expression = {
    emoji: string;
    label: string; // For default: translation key. For custom: literal text.
    type: ExpressionType;
    isDefault: boolean;
};

export type Sticker = Expression & {
    imageUrl: string | null; // The final image to display/download
    originalImageUrl: string | null; // The raw image from the AI, for reprocessing
    status: StickerStatus;
};

export type TransparencyOptions = {
    colorTol: number;
    tileGuess: number;
    gradKeep: number;
    feather: number;
    seedPoints?: TransparencySeed[];
    mode?: 'auto' | 'seed' | 'auto+seed';
};

export type GridSize = 'small' | 'medium' | 'large';

export type TransparencySeed = {
    x: number; // Pixel coordinate in the source image
    y: number;
    force?: boolean;
};

export type Translations = Partial<Record<Language, Record<string, string>>>;
