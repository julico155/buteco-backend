import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { NotFoundDomainError } from '../common/exceptions/domain-exception';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

export interface CategoryResponse {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

@Injectable()
export class CategoriesService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Por defecto solo las activas (es lo que consume el catálogo). El
   * mantenimiento de menú necesita `includeInactive`: sin eso, desactivar una
   * categoría la vuelve irrecuperable desde la UI.
   */
  async findMany(includeInactive = false): Promise<CategoryResponse[]> {
    let query = this.db.selectFrom('categories').selectAll();
    if (!includeInactive) query = query.where('is_active', '=', true);
    const rows = await query.orderBy('sort_order', 'asc').execute();
    return rows.map(toCategoryResponse);
  }

  async create(dto: CreateCategoryDto): Promise<CategoryResponse> {
    const row = await this.db
      .insertInto('categories')
      .values({
        name: dto.name,
        sort_order: dto.sortOrder,
        is_active: dto.isActive,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCategoryResponse(row);
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryResponse> {
    const row = await this.db
      .updateTable('categories')
      .set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.sortOrder !== undefined ? { sort_order: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw new NotFoundDomainError('category', id);
    return toCategoryResponse(row);
  }
}

function toCategoryResponse(row: {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}): CategoryResponse {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}
