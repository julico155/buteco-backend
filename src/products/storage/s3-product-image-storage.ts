import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ProductImageStorage, PutObjectInput } from './product-image-storage';

export interface S3ProductImageStorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Solo para proveedores S3-compatibles que no son AWS (Cloudflare R2, MinIO, etc.). */
  endpoint?: string;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Bucket/credenciales de la config `s3` de AppConfig (STORAGE_S3_*).
 * `putObject` SIEMPRE sobrescribe, porque reemplazar la foto de un producto
 * es el caso de uso normal, no una anomalía a evitar.
 */
export class S3ProductImageStorage implements ProductImageStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3ProductImageStorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    });
  }

  async putObject({ key, bytes, mimeType }: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: mimeType,
      }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return streamToBuffer(result.Body);
  }
}
