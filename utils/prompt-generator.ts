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

    const outlineInstruction = 'Create a digital sticker outline designed in the same cohesive pack style: a clean image subject cutout with a consistent medium-thick outline (3–5px) in solid white and a soft gray shadow. The outline should be even all around, with no harsh edge variations. The lighting, color tone, and shadow direction should be consistent across all stickers.';

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
