import sharp from 'sharp';
import { parse, Font } from 'opentype.js';
import { readFileSync } from 'node:fs';

export interface QrImageCaptionInput {
  qrImageBase64: string;
  amountBs: number;
  concept: string;
}

const BAND_HEIGHT = 76;
const FALLBACK_SIZE = 400;
const AMOUNT_FONT_SIZE = 24;
const CONCEPT_FONT_SIZE = 17;

// Contenedores (Railway/Nixpacks incluidos) suelen no traer NINGUNA fuente
// instalada: pedirle texto a librsvg/fontconfig ahí no falla, pero renderiza
// los glifos como cuadraditos ("tofu"). Por eso el texto se convierte acá
// mismo a paths vectoriales con la fuente empaquetada en el repo — cero
// dependencia de fuentes/fontconfig del sistema operativo, en cualquier
// entorno. El layout es manual (charToGlyph, sin stringToGlyphs) porque el
// pipeline de features OpenType (GSUB/ccmp) de DejaVu Sans no lo soporta
// opentype.js 2.0.0 (lookupType 6 format 2) — no hace falta para texto
// simple ASCII sin ligaduras como el que mandamos acá.
const regularFont = loadFont('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const boldFont = loadFont('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

function loadFont(pkgRelativePath: string): Font {
  const bytes = readFileSync(require.resolve(pkgRelativePath));
  return parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/**
 * El QR que devuelve el banco trae quemado su propio texto genérico (monto
 * en 0, glosa fija) — no refleja lo que realmente se cobra. Le agregamos
 * abajo, en una franja blanca que nosotros controlamos, el monto y el
 * concepto reales del pedido, sin tocar el QR en sí (sigue siendo
 * escaneable tal cual lo firmó el banco).
 */
export async function withAmountCaption(input: QrImageCaptionInput): Promise<Buffer> {
  const qrBuffer = Buffer.from(input.qrImageBase64, 'base64');
  const metadata = await sharp(qrBuffer).metadata();
  const width = metadata.width ?? FALLBACK_SIZE;
  const qrHeight = metadata.height ?? width;

  const amountPath = centeredTextPath(boldFont, `Monto: Bs ${input.amountBs.toFixed(2)}`, AMOUNT_FONT_SIZE, width / 2, 34);
  const conceptPath = centeredTextPath(regularFont, `Concepto: ${input.concept}`, CONCEPT_FONT_SIZE, width / 2, 60);

  const band = Buffer.from(`
    <svg width="${width}" height="${BAND_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <path d="${amountPath}" fill="#000000"/>
      <path d="${conceptPath}" fill="#000000"/>
    </svg>
  `);

  return sharp({
    create: { width, height: qrHeight + BAND_HEIGHT, channels: 3, background: '#ffffff' },
  })
    .composite([
      { input: qrBuffer, top: 0, left: 0 },
      { input: band, top: qrHeight, left: 0 },
    ])
    .png()
    .toBuffer();
}

/**
 * Layout manual carácter por carácter (ver comentario de arriba sobre por
 * qué no se usa `font.getPath(text, ...)`), centrado horizontalmente en
 * `centerX` con la base de línea en `baselineY`.
 */
function centeredTextPath(font: Font, text: string, fontSize: number, centerX: number, baselineY: number): string {
  const scale = fontSize / font.unitsPerEm;
  const glyphs = [...text].map((char) => font.charToGlyph(char));
  const totalWidth = glyphs.reduce((sum, glyph) => sum + (glyph.advanceWidth ?? 0) * scale, 0);

  let x = centerX - totalWidth / 2;
  const segments: string[] = [];
  for (const glyph of glyphs) {
    segments.push(glyph.getPath(x, baselineY, fontSize).toPathData(2));
    x += (glyph.advanceWidth ?? 0) * scale;
  }
  return segments.join(' ');
}
