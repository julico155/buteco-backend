import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { DomainException, NotFoundDomainError } from '../common/exceptions/domain-exception';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export type PromotionStatus =
  'activa' | 'agotada' | 'sin_ahorro' | 'inactiva' | 'archivada' | 'programada' | 'expirada';

export interface PromotionItemResponse {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface PromotionResponse {
  id: string;
  name: string;
  description: string | null;
  promoPrice: number;
  isActive: boolean;
  archivedAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  sortOrder: number;
  imageUrl: string | null;
  revision: number;
  status: PromotionStatus;
  items: PromotionItemResponse[];
}

export interface PromotionRow {
  id: string;
  name: string;
  description: string | null;
  promo_price: string;
  is_active: boolean;
  archived_at: Date | string | null;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  sort_order: number;
  image_url: string | null;
  revision: number;
}

export interface PromotionItemRow {
  promotion_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: string;
  product_is_active: boolean;
  product_is_available: boolean;
}

/**
 * Combos. GET expone el `status` calculado para el menú; el resto de
 * endpoints son de gestión de staff. Las promociones se compran dentro de
 * POST /orders junto a productos sueltos (ver módulo `orders`, todavía sin
 * implementar) — este servicio solo gestiona el catálogo de combos.
 */
@Injectable()
export class PromotionsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async findAll(): Promise<PromotionResponse[]> {
    const promotions = await this.db
      .selectFrom('promotions')
      .selectAll()
      .orderBy('sort_order', 'asc')
      .execute();
    const itemsByPromotion = await this.loadItems(
      this.db,
      promotions.map((p) => p.id),
    );
    return promotions.map((p) => toPromotionResponse(p, itemsByPromotion.get(p.id) ?? []));
  }

  async findOne(id: string): Promise<PromotionResponse> {
    const promotion = await this.db
      .selectFrom('promotions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!promotion) throw new NotFoundDomainError('promotion', id);
    const itemsByPromotion = await this.loadItems(this.db, [id]);
    return toPromotionResponse(promotion, itemsByPromotion.get(id) ?? []);
  }

  async create(dto: CreatePromotionDto): Promise<PromotionResponse> {
    return this.db.transaction().execute(async (trx) => {
      const promotion = await trx
        .insertInto('promotions')
        .values({
          name: dto.name,
          description: dto.description,
          promo_price: dto.promoPrice.toFixed(2),
          starts_at: dto.startsAt,
          ends_at: dto.endsAt,
          image_url: dto.imageUrl,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.replaceItems(trx, promotion.id, dto.items);
      const itemsByPromotion = await this.loadItems(trx, [promotion.id]);
      return toPromotionResponse(promotion, itemsByPromotion.get(promotion.id) ?? []);
    });
  }

  async update(id: string, dto: UpdatePromotionDto): Promise<PromotionResponse> {
    return this.db.transaction().execute(async (trx) => {
      const promotion = await trx
        .updateTable('promotions')
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.promoPrice !== undefined ? { promo_price: dto.promoPrice.toFixed(2) } : {}),
          ...(dto.startsAt !== undefined ? { starts_at: dto.startsAt } : {}),
          ...(dto.endsAt !== undefined ? { ends_at: dto.endsAt } : {}),
          ...(dto.imageUrl !== undefined ? { image_url: dto.imageUrl } : {}),
          revision: (eb) => eb('revision', '+', 1),
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();

      if (!promotion) throw new NotFoundDomainError('promotion', id);

      if (dto.items) {
        await this.replaceItems(trx, id, dto.items);
      }
      const itemsByPromotion = await this.loadItems(trx, [id]);
      return toPromotionResponse(promotion, itemsByPromotion.get(id) ?? []);
    });
  }

  async setActive(id: string, active: boolean): Promise<PromotionResponse> {
    const promotion = await this.db
      .updateTable('promotions')
      .set({ is_active: active, revision: (eb) => eb('revision', '+', 1), updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!promotion) throw new NotFoundDomainError('promotion', id);
    const itemsByPromotion = await this.loadItems(this.db, [id]);
    return toPromotionResponse(promotion, itemsByPromotion.get(id) ?? []);
  }

  async setArchived(id: string, archived: boolean): Promise<PromotionResponse> {
    // Invariante de esquema promotions_archived_not_active: al archivar,
    // is_active pasa a false en la misma escritura.
    const promotion = await this.db
      .updateTable('promotions')
      .set({
        archived_at: archived ? new Date() : null,
        ...(archived ? { is_active: false } : {}),
        revision: (eb) => eb('revision', '+', 1),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!promotion) throw new NotFoundDomainError('promotion', id);
    const itemsByPromotion = await this.loadItems(this.db, [id]);
    return toPromotionResponse(promotion, itemsByPromotion.get(id) ?? []);
  }

  async duplicate(id: string): Promise<PromotionResponse> {
    return this.db.transaction().execute(async (trx) => {
      const source = await trx
        .selectFrom('promotions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!source) throw new NotFoundDomainError('promotion', id);

      const sourceItems = await trx
        .selectFrom('promotion_items')
        .select(['product_id', 'quantity'])
        .where('promotion_id', '=', id)
        .execute();

      const copy = await trx
        .insertInto('promotions')
        .values({
          name: `${source.name} (copia)`,
          description: source.description,
          promo_price: source.promo_price,
          starts_at: source.starts_at,
          ends_at: source.ends_at,
          image_url: source.image_url,
          sort_order: source.sort_order + 1,
          is_active: false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      if (sourceItems.length > 0) {
        await trx
          .insertInto('promotion_items')
          .values(
            sourceItems.map((item) => ({
              promotion_id: copy.id,
              product_id: item.product_id,
              quantity: item.quantity,
            })),
          )
          .execute();
      }

      const itemsByPromotion = await this.loadItems(trx, [copy.id]);
      return toPromotionResponse(copy, itemsByPromotion.get(copy.id) ?? []);
    });
  }

  async move(id: string, sortOrder: number): Promise<PromotionResponse> {
    const promotion = await this.db
      .updateTable('promotions')
      .set({ sort_order: sortOrder, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!promotion) throw new NotFoundDomainError('promotion', id);
    const itemsByPromotion = await this.loadItems(this.db, [id]);
    return toPromotionResponse(promotion, itemsByPromotion.get(id) ?? []);
  }

  /**
   * Un mismo producto no puede aparecer dos veces en la misma promoción
   * (`unique (promotion_id, product_id)`) — "2 unidades de un producto" se
   * expresa con `quantity`, no repitiendo la línea. Se valida acá antes de
   * tocar la base (mensaje preciso, con el producto exacto) y además se
   * atrapa el unique violation como red de seguridad, para no dejar
   * escapar nunca un 500 crudo de Postgres.
   */
  private async replaceItems(
    trx: Transaction<Database>,
    promotionId: string,
    items: { productId: string; quantity: number }[],
  ): Promise<void> {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const item of items) {
      if (seen.has(item.productId)) duplicated.add(item.productId);
      seen.add(item.productId);
    }
    if (duplicated.size > 0) {
      throw new DomainException(
        'promotion_duplicate_product',
        HttpStatus.BAD_REQUEST,
        'Un producto no puede repetirse en la misma promoción — usá quantity para varias unidades.',
        { productIds: [...duplicated] },
      );
    }

    await trx.deleteFrom('promotion_items').where('promotion_id', '=', promotionId).execute();
    try {
      await trx
        .insertInto('promotion_items')
        .values(
          items.map((item) => ({
            promotion_id: promotionId,
            product_id: item.productId,
            quantity: item.quantity,
          })),
        )
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          'promotion_duplicate_product',
          HttpStatus.BAD_REQUEST,
          'Un producto no puede repetirse en la misma promoción — usá quantity para varias unidades.',
        );
      }
      throw error;
    }
  }

  private async loadItems(
    executor: Kysely<Database> | Transaction<Database>,
    promotionIds: string[],
  ): Promise<Map<string, PromotionItemRow[]>> {
    if (promotionIds.length === 0) return new Map();
    const rows = await executor
      .selectFrom('promotion_items')
      .innerJoin('products', 'products.id', 'promotion_items.product_id')
      .select([
        'promotion_items.promotion_id as promotion_id',
        'promotion_items.product_id as product_id',
        'products.name as product_name',
        'promotion_items.quantity as quantity',
        'products.price as unit_price',
        'products.is_active as product_is_active',
        'products.is_available as product_is_available',
      ])
      .where('promotion_items.promotion_id', 'in', promotionIds)
      .execute();

    const map = new Map<string, PromotionItemRow[]>();
    for (const row of rows) {
      const list = map.get(row.promotion_id) ?? [];
      list.push(row);
      map.set(row.promotion_id, list);
    }
    return map;
  }
}

export function computeStatus(promotion: PromotionRow, items: PromotionItemRow[]): PromotionStatus {
  const now = new Date();
  if (promotion.archived_at) return 'archivada';
  if (!promotion.is_active) return 'inactiva';
  if (promotion.starts_at && new Date(promotion.starts_at) > now) return 'programada';
  // <= y no <: mismo corte que la revalidación del checkout (orders.service.ts),
  // si no en el instante exacto de ends_at la promo se muestra activa y el
  // checkout la rechaza.
  if (promotion.ends_at && new Date(promotion.ends_at) <= now) return 'expirada';
  if (items.some((item) => !item.product_is_active || !item.product_is_available)) return 'agotada';

  const regularTotal = items.reduce(
    (sum, item) => sum + Number(item.unit_price) * item.quantity,
    0,
  );
  if (Number(promotion.promo_price) >= regularTotal) return 'sin_ahorro';
  return 'activa';
}

function toPromotionResponse(
  promotion: PromotionRow,
  items: PromotionItemRow[],
): PromotionResponse {
  return {
    id: promotion.id,
    name: promotion.name,
    description: promotion.description,
    promoPrice: Number(promotion.promo_price),
    isActive: promotion.is_active,
    archivedAt: promotion.archived_at ? new Date(promotion.archived_at).toISOString() : null,
    startsAt: promotion.starts_at ? new Date(promotion.starts_at).toISOString() : null,
    endsAt: promotion.ends_at ? new Date(promotion.ends_at).toISOString() : null,
    sortOrder: promotion.sort_order,
    imageUrl: promotion.image_url,
    revision: promotion.revision,
    status: computeStatus(promotion, items),
    items: items.map((item) => ({
      productId: item.product_id,
      productName: item.product_name,
      quantity: item.quantity,
      unitPrice: Number(item.unit_price),
    })),
  };
}
