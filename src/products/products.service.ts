import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import {
  DomainException,
  NotFoundDomainError,
  ValidationError,
} from '../common/exceptions/domain-exception';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UploadProductImageDto } from './dto/upload-product-image.dto';
import {
  buildProductImageKey,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_STORAGE,
  ProductImageStorage,
} from './storage/product-image-storage';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export interface ProductComplementResponse {
  id: string;
  name: string;
  sortOrder: number;
}

export interface ProductResponse {
  id: string;
  code: string;
  name: string;
  description: string | null;
  categoryId: string;
  price: number;
  isActive: boolean;
  isAvailable: boolean;
  sortOrder: number;
  /** Ruta relativa al backend, no una URL directa al bucket. Null si el producto no tiene foto. */
  imageUrl: string | null;
  /** Todos van incluidos por defecto en el pedido; esta lista es solo lo que se puede destildar (ej. "sin cebolla"). */
  complements: ProductComplementResponse[];
}

@Injectable()
export class ProductsService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    @Inject(PRODUCT_IMAGE_STORAGE) private readonly imageStorage: ProductImageStorage,
  ) {}

  /**
   * Por defecto solo los activos (es lo que consume el catálogo de venta).
   * El mantenimiento de menú necesita `includeInactive` para poder
   * reactivar uno: sin eso, desactivarlo lo vuelve irrecuperable desde la
   * UI. Sold-out ≠ inactivo (invariante 4) — `isAvailable` no se toca acá.
   */
  async findMany(includeInactive = false): Promise<ProductResponse[]> {
    let query = this.db.selectFrom('products').selectAll();
    if (!includeInactive) query = query.where('is_active', '=', true);
    const rows = await query.orderBy('sort_order', 'asc').execute();
    if (rows.length === 0) return [];

    const complementRows = await this.db
      .selectFrom('product_complements')
      .selectAll()
      .where(
        'product_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('sort_order', 'asc')
      .execute();
    const complementsByProduct = groupComplementsByProduct(complementRows);

    return rows.map((row) => toProductResponse(row, complementsByProduct.get(row.id) ?? []));
  }

  async create(dto: CreateProductDto): Promise<ProductResponse> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('products')
          .values({
            code: dto.code,
            name: dto.name,
            description: dto.description ?? null,
            category_id: dto.categoryId,
            price: dto.price.toFixed(2),
            is_active: dto.isActive,
            is_available: dto.isAvailable,
            sort_order: dto.sortOrder,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const complements = await this.replaceComplements(trx, row.id, dto.complements);
        return toProductResponse(row, complements);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          'product_code_taken',
          HttpStatus.CONFLICT,
          `Ya existe un producto con el código "${dto.code}".`,
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductResponse> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('products')
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.categoryId !== undefined ? { category_id: dto.categoryId } : {}),
          ...(dto.price !== undefined ? { price: dto.price.toFixed(2) } : {}),
          ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
          ...(dto.sortOrder !== undefined ? { sort_order: dto.sortOrder } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();

      if (!row) throw new NotFoundDomainError('product', id);

      const complements =
        dto.complements !== undefined
          ? await this.replaceComplements(trx, id, dto.complements)
          : await trx
              .selectFrom('product_complements')
              .selectAll()
              .where('product_id', '=', id)
              .orderBy('sort_order', 'asc')
              .execute();

      return toProductResponse(row, complements);
    });
  }

  /** Reemplaza la lista completa de complementos de un producto (mismo patrón que promotions.replaceItems). */
  private async replaceComplements(
    trx: Kysely<Database>,
    productId: string,
    complements: { name: string; sortOrder?: number }[] | undefined,
  ) {
    await trx.deleteFrom('product_complements').where('product_id', '=', productId).execute();
    if (!complements || complements.length === 0) return [];

    const names = complements.map((c) => c.name.trim());
    if (new Set(names).size !== names.length) {
      throw new ValidationError('El producto tiene complementos duplicados.');
    }

    return trx
      .insertInto('product_complements')
      .values(
        complements.map((c, index) => ({
          product_id: productId,
          name: c.name.trim(),
          sort_order: c.sortOrder ?? index,
        })),
      )
      .returningAll()
      .execute();
  }

  /** PATCH /products/:id/availability — toggle de staff, no afecta is_active. */
  async setAvailability(id: string, available: boolean): Promise<ProductResponse> {
    const row = await this.db
      .updateTable('products')
      .set({ is_available: available, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw new NotFoundDomainError('product', id);
    return toProductResponse(row, await this.loadComplements(id));
  }

  /** POST /products/:id/image — reemplaza la foto si ya había una (misma key, ver buildProductImageKey). */
  async uploadImage(id: string, dto: UploadProductImageDto): Promise<ProductResponse> {
    const bytes = Buffer.from(dto.fileBase64, 'base64');
    if (bytes.length === 0 || bytes.length > PRODUCT_IMAGE_MAX_BYTES) {
      throw new DomainException(
        'invalid_image',
        HttpStatus.BAD_REQUEST,
        `El archivo debe pesar entre 1 byte y ${PRODUCT_IMAGE_MAX_BYTES} bytes.`,
      );
    }

    const key = buildProductImageKey(id);
    await this.imageStorage.putObject({ key, bytes, mimeType: dto.mimeType });

    const row = await this.db
      .updateTable('products')
      .set({ image_key: key, image_mime_type: dto.mimeType, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw new NotFoundDomainError('product', id);
    return toProductResponse(row, await this.loadComplements(id));
  }

  private async loadComplements(productId: string) {
    return this.db
      .selectFrom('product_complements')
      .selectAll()
      .where('product_id', '=', productId)
      .orderBy('sort_order', 'asc')
      .execute();
  }

  /** GET /products/:id/image — nunca una URL directa al bucket, se sirve siempre a través del backend. */
  async getImage(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const row = await this.db
      .selectFrom('products')
      .select(['image_key', 'image_mime_type'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('product', id);
    if (!row.image_key || !row.image_mime_type) {
      throw new DomainException(
        'product_image_not_set',
        HttpStatus.NOT_FOUND,
        'El producto no tiene foto.',
      );
    }
    const bytes = await this.imageStorage.getObject(row.image_key);
    return { bytes, mimeType: row.image_mime_type };
  }
}

function toProductResponse(
  row: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    category_id: string;
    price: string;
    is_active: boolean;
    is_available: boolean;
    sort_order: number;
    image_key: string | null;
  },
  complements: { id: string; name: string; sort_order: number }[],
): ProductResponse {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    categoryId: row.category_id,
    price: Number(row.price),
    isActive: row.is_active,
    isAvailable: row.is_available,
    sortOrder: row.sort_order,
    imageUrl: row.image_key ? `/products/${row.id}/image` : null,
    complements: complements.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sort_order })),
  };
}

function groupComplementsByProduct(
  rows: { id: string; product_id: string; name: string; sort_order: number }[],
) {
  const byProduct = new Map<string, { id: string; name: string; sort_order: number }[]>();
  for (const row of rows) {
    const list = byProduct.get(row.product_id) ?? [];
    list.push(row);
    byProduct.set(row.product_id, list);
  }
  return byProduct;
}
