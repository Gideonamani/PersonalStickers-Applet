import type { Expression } from '../types';

export const generatePrompt = (
    expression: Expression,
    artisticStyle: string,
    transparentBackground: boolean,
    backgroundColor: string,
    translations: any
): string => {
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

    const stickerFinish = 'The image should be a die-cut sticker with a triple-stroke border: a dark-grey outer stroke, a thin white middle stroke, and a dark-grey inner stroke. It must have clean cutout edges and smooth border curvature. Also add a subtle soft shadow under the sticker.'

    return `Generate a high-quality sticker of the character showing a "${englishLabel}" expression. ${specificInstruction} The artistic style MUST be ${styleInstruction}. The sticker must have ${backgroundInstruction}. ${stickerFinish} The final output must be a PNG file. Ensure the style is consistent across all stickers. Do not add extra background elements or text.`;
};