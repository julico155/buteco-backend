import { IsIn, IsString, MinLength } from 'class-validator';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export class UploadProductImageDto {
  @IsIn(ALLOWED_MIME_TYPES)
  mimeType!: string;

  /** Bytes del archivo en base64. */
  @IsString()
  @MinLength(1)
  fileBase64!: string;
}
