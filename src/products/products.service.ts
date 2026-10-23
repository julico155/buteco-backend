import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import {
  DomainException,
  NotFoundDomainError,
  ValidationError,
} from '../common/exceptions/domain-exception';
import { isAvailableOnDay } from '../orders/order-item-options';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UploadProductImageDto } from './dto/upload-product-image.dto';
import { ReplaceProductOptionGroupsDto } from './dto/product-option-groups.dto';
import {
  buildProductImageKey,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_STORAGE,
  ProductImageStorage,
} from './storage/product-image-storage';

import { ProductComplementResponse, ProductOptionResponse, ProductOptionGroupResponse, ProductResponse } from './dto/product-response.dto';
export { ProductComplementResponse, ProductOptionResponse, ProductOptionGroupResponse, ProductResponse };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
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
    const groupsByProduct = await this.loadOptionGroups(
      this.db,
      rows.map((r) => r.id),
    );

    return rows.map((row) =>
      toProductResponse(row, complementsByProduct.get(row.id) ?? [], groupsByProduct.get(row.id) ?? []),
    );
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
            available_weekdays: dto.availableWeekdays ? sortedWeekdays(dto.availableWeekdays) : null,
            serves_label: dto.servesLabel?.trim() || null,
            prep_minutes: dto.prepMinutes ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const complements = await this.replaceComplements(trx, row.id, dto.complements);
        // Los grupos de opciones se cargan con PUT /products/:id/option-groups.
        return toProductResponse(row, complements, []);
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
          // `null` borra el valor (todos los días / sin etiqueta / sin tiempo); omitido no lo toca.
          ...(dto.availableWeekdays !== undefined
            ? { available_weekdays: dto.availableWeekdays === null ? null : sortedWeekdays(dto.availableWeekdays) }
            : {}),
          ...(dto.servesLabel !== undefined ? { serves_label: dto.servesLabel?.trim() || null } : {}),
          ...(dto.prepMinutes !== undefined ? { prep_minutes: dto.prepMinutes } : {}),
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

      const groups = (await this.loadOptionGroups(trx, [id])).get(id) ?? [];
      return toProductResponse(row, complements, groups);
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

  /**
   * PUT /products/:id/option-groups — reemplaza la lista COMPLETA de grupos y opciones del producto. Lo que ya existe se
   * identifica por `code` (grupo dentro del producto, opción dentro del grupo) y CONSERVA su id: los carritos en vuelo y el
   * `cart` de un pedido reemplazable llevan esos ids, así que borrar y recrear los invalidaría. Lo que no viene se borra
   * (los pedidos viejos no se alteran: guardan su propio snapshot).
   */
  async replaceOptionGroups(id: string, dto: ReplaceProductOptionGroupsDto): Promise<ProductResponse> {
    assertValidOptionGroups(dto);
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('products').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!row) throw new NotFoundDomainError('product', id);

      const existingGroups = await trx
        .selectFrom('product_option_groups')
        .selectAll()
        .where('product_id', '=', id)
        .execute();
      const groupByCode = new Map(existingGroups.map((g) => [g.code, g]));
      const keepGroupIds: string[] = [];

      for (const [groupIndex, group] of dto.groups.entries()) {
        const values = {
          name: group.name.trim(),
          min_select: group.minSelect ?? 1,
          max_select: group.maxSelect ?? 1,
          sort_order: group.sortOrder ?? groupIndex,
          show_in_notice: group.showInNotice ?? false,
        };
        const existing = groupByCode.get(group.code);
        const saved = existing
          ? await trx
              .updateTable('product_option_groups')
              .set(values)
              .where('id', '=', existing.id)
              .returning('id')
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto('product_option_groups')
              .values({ product_id: id, code: group.code, ...values })
              .returning('id')
              .executeTakeFirstOrThrow();
        keepGroupIds.push(saved.id);

        const existingOptions = existing
          ? await trx.selectFrom('product_options').selectAll().where('group_id', '=', saved.id).execute()
          : [];
        const optionByCode = new Map(existingOptions.map((o) => [o.code, o]));
        const keepOptionIds: string[] = [];
        for (const [optionIndex, option] of group.options.entries()) {
          const optionValues = {
            name: option.name.trim(),
            price_delta: (option.priceDelta ?? 0).toFixed(2),
            is_available: option.isAvailable ?? true,
            sort_order: option.sortOrder ?? optionIndex,
          };
          const existingOption = optionByCode.get(option.code);
          const savedOption = existingOption
            ? await trx
                .updateTable('product_options')
                .set(optionValues)
                .where('id', '=', existingOption.id)
                .returning('id')
                .executeTakeFirstOrThrow()
            : await trx
                .insertInto('product_options')
                .values({ group_id: saved.id, code: option.code, ...optionValues })
                .returning('id')
                .executeTakeFirstOrThrow();
          keepOptionIds.push(savedOption.id);
        }
        const staleOptionIds = existingOptions.map((o) => o.id).filter((optionId) => !keepOptionIds.includes(optionId));
        if (staleOptionIds.length > 0) {
          await trx.deleteFrom('product_options').where('id', 'in', staleOptionIds).execute();
        }
      }

      const staleGroupIds = existingGroups.map((g) => g.id).filter((groupId) => !keepGroupIds.includes(groupId));
      if (staleGroupIds.length > 0) {
        await trx.deleteFrom('product_option_groups').where('id', 'in', staleGroupIds).execute();
      }

      await trx.updateTable('products').set({ updated_at: new Date() }).where('id', '=', id).execute();
      const complements = await trx
        .selectFrom('product_complements')
        .selectAll()
        .where('product_id', '=', id)
        .orderBy('sort_order', 'asc')
        .execute();
      const groups = (await this.loadOptionGroups(trx, [id])).get(id) ?? [];
      return toProductResponse(row, complements, groups);
    });
  }

  /** PATCH /products/options/:optionId/availability — «se acabó esta carne». Decisión de piso de cocina, como el agotado de un producto. */
  async setOptionAvailability(optionId: string, available: boolean): Promise<ProductResponse> {
    const option = await this.db
      .updateTable('product_options')
      .set({ is_available: available })
      .where('id', '=', optionId)
      .returning('group_id')
      .executeTakeFirst();
    if (!option) throw new NotFoundDomainError('product_option', optionId);
    const group = await this.db
      .selectFrom('product_option_groups')
      .select('product_id')
      .where('id', '=', option.group_id)
      .executeTakeFirstOrThrow();
    const row = await this.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', group.product_id)
      .executeTakeFirstOrThrow();
    return this.hydrate(row);
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
    return this.hydrate(row);
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
    return this.hydrate(row);
  }

  private async hydrate(row: Parameters<typeof toProductResponse>[0]): Promise<ProductResponse> {
    const groups = (await this.loadOptionGroups(this.db, [row.id])).get(row.id) ?? [];
    return toProductResponse(row, await this.loadComplements(row.id), groups);
  }

  private async loadComplements(productId: string) {
    return this.db
      .selectFrom('product_complements')
      .selectAll()
      .where('product_id', '=', productId)
      .orderBy('sort_order', 'asc')
      .execute();
  }

  private async loadOptionGroups(
    executor: Kysely<Database> | Transaction<Database>,
    productIds: string[],
  ): Promise<Map<string, ProductOptionGroupResponse[]>> {
    const byProduct = new Map<string, ProductOptionGroupResponse[]>();
    if (productIds.length === 0) return byProduct;
    const groups = await executor
      .selectFrom('product_option_groups')
      .selectAll()
      .where('product_id', 'in', productIds)
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
    if (groups.length === 0) return byProduct;
    const options = await executor
      .selectFrom('product_options')
      .selectAll()
      .where(
        'group_id',
        'in',
        groups.map((g) => g.id),
      )
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
    const optionsByGroup = new Map<string, ProductOptionResponse[]>();
    for (const option of options) {
      const list = optionsByGroup.get(option.group_id) ?? [];
      list.push({
        id: option.id,
        code: option.code,
        name: option.name,
        priceDelta: Number(option.price_delta),
        isAvailable: option.is_available,
        sortOrder: option.sort_order,
      });
      optionsByGroup.set(option.group_id, list);
    }
    for (const group of groups) {
      const list = byProduct.get(group.product_id) ?? [];
      list.push({
        id: group.id,
        code: group.code,
        name: group.name,
        minSelect: group.min_select,
        maxSelect: group.max_select,
        sortOrder: group.sort_order,
        showInNotice: group.show_in_notice,
        options: optionsByGroup.get(group.id) ?? [],
      });
      byProduct.set(group.product_id, list);
    }
    return byProduct;
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

export function toProductResponse(
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
    available_weekdays: number[] | null;
    serves_label: string | null;
    prep_minutes: number | null;
  },
  complements: { id: string; name: string; sort_order: number }[],
  optionGroups: ProductOptionGroupResponse[],
  now: Date = new Date(),
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
    optionGroups,
    availableWeekdays: row.available_weekdays,
    isAvailableToday: isAvailableOnDay(row.available_weekdays, now),
    servesLabel: row.serves_label,
    prepMinutes: row.prep_minutes,
  };
}

function sortedWeekdays(weekdays: number[]): number[] {
  return [...new Set(weekdays)].sort((a, b) => a - b);
}

/** Reglas que el DTO no puede expresar: unicidad de códigos y coherencia de min/max con la cantidad de opciones. */
export function assertValidOptionGroups(dto: ReplaceProductOptionGroupsDto): void {
  const groupCodes = dto.groups.map((g) => g.code);
  if (new Set(groupCodes).size !== groupCodes.length) {
    throw new ValidationError('El producto tiene grupos de opciones con el mismo code.');
  }
  for (const group of dto.groups) {
    const optionCodes = group.options.map((o) => o.code);
    if (new Set(optionCodes).size !== optionCodes.length) {
      throw new ValidationError(`El grupo "${group.code}" tiene opciones con el mismo code.`);
    }
    const min = group.minSelect ?? 1;
    const max = group.maxSelect ?? 1;
    if (min > max) {
      throw new ValidationError(`El grupo "${group.code}": minSelect no puede superar a maxSelect.`);
    }
    if (max > group.options.length) {
      throw new ValidationError(`El grupo "${group.code}": maxSelect no puede superar la cantidad de opciones.`);
    }
  }
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
