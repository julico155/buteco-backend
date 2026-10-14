export interface PutObjectInput {
  key: string;
  bytes: Buffer;
  mimeType: string;
}

export interface ProductImageStorage {
  /** Sobrescribe: reemplazar la foto es el caso de uso normal. */
  putObject(input: PutObjectInput): Promise<void>;
  getObject(key: string): Promise<Buffer>;
}

export const PRODUCT_IMAGE_STORAGE = Symbol('PRODUCT_IMAGE_STORAGE');

export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isAllowedProductImageMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

/**
 * Key determinística por producto, sin extensión — el mime type real vive
 * en `products.image_mime_type`, no en el nombre del archivo. Así un
 * reemplazo de foto (aunque cambie de jpg a png) pisa siempre el mismo
 * objeto, sin dejar huérfanos en el bucket.
 */
export function buildProductImageKey(productId: string): string {
  return `products/${productId.toLowerCase()}`;
}
