import sharp from 'sharp';
import { withAmountCaption } from './qr-image-caption';

async function fakeQrImageBase64(size = 100): Promise<string> {
  const buffer = await sharp({
    create: { width: size, height: size, channels: 3, background: '#000000' },
  })
    .png()
    .toBuffer();
  return buffer.toString('base64');
}

describe('withAmountCaption', () => {
  it('agrega una franja debajo del QR con el ancho del QR original', async () => {
    const qrImageBase64 = await fakeQrImageBase64(120);

    const result = await withAmountCaption({ qrImageBase64, amountBs: 22, concept: 'Pedido ORD-260929-007' });
    const metadata = await sharp(result).metadata();

    expect(metadata.width).toBe(120);
    expect(metadata.height).toBeGreaterThan(120);
    expect(metadata.format).toBe('png');
  });

  it('no revienta con montos con más de dos decimales ni conceptos con caracteres especiales', async () => {
    const qrImageBase64 = await fakeQrImageBase64(80);

    await expect(
      withAmountCaption({ qrImageBase64, amountBs: 22.005, concept: 'Pedido <ORD & Cía>' }),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
