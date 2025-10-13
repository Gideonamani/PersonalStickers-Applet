import type { Expression, Translations } from '../types';

export const generatePrompt = (
    expression: Expression,
    artisticStyle: string,
    transparentBackground: boolean,
    backgroundColor: string,
    translations: Translations
): string => {
    const styleMap: Record<string, string> = {
        Anime: 'a vibrant anime/manga cel-shaded style with bold, tidy linework',
        '3D Render': 'a polished, well-lit 3D render style similar to contemporary animated features',
        'Photo-realistic': 'a photo-realistic style that looks like a professional studio photograph',
    };
    const styleInstruction = styleMap[artisticStyle] ?? 'a cohesive, high-quality illustration style';

    const backgroundInstruction = transparentBackground
        ? 'the background must be 100% transparent with a real alpha channel—no checkerboard simulation, halo, glow, or drop shadow'
        : `fill the entire background with the flat, solid hex colour ${backgroundColor}. Do not add gradients, lighting flares, textures, sparkles, text, or extra graphics`;

    const outlineInstruction = `Create a digital sticker outline in a cohesive pack style. 
    The design must feature: A clean subject cutout with smooth edges. A consistent medium-thick white outline (around 4 px) that fully surrounds the subject — no edge of the subject should touch the canvas border. 
    Around the white outline, add a thin medium-gray border (1 px) to ensure contrast on both white and transparent backgrounds. 
    Maintain equal outline thickness on all sides — no tapered or faded edges. 
    No directional shadows or blurs; only the clean double-outline effect (white + thin gray).`;

    const framingInstruction =
        expression.type === 'plain'
            ? 'Use a chest-up crop that keeps the pose natural, centred, and evenly padded on all sides.'
            : 'Use a dynamic, meme-ready pose that stays centred with even padding; keep the entire body portion visible and avoid extra props or text.';

    const getEnglishLabel = (exp: Expression) => {
        if (!exp.isDefault) {
            return exp.label; // Custom labels are literal strings
        }
        // For default expressions, get the English translation from the key
        return translations?.en?.[exp.label] || exp.label; // Fallback to key if not found
    };
    const englishLabel = getEnglishLabel(expression);

    const optimisationNote =
        'Optimise the artwork for use as a WhatsApp chat sticker so it reads clearly at small size and removes cleanly with transparency tools.';

    return `Generate a 512x512 PNG sticker featuring the same character showing a "${englishLabel}" expression. ${framingInstruction} The artistic style MUST be ${styleInstruction}. ${optimisationNote} Ensure the subject remains centred, fully inside the frame, and maintains consistent skin tone, clothing, and hairstyle with previous stickers from the user photo reference. The sticker must have ${backgroundInstruction}. ${outlineInstruction} Keep the edges sharp with minimal anti-aliasing to support clean background removal. Output a single PNG image and nothing else.`;
};
