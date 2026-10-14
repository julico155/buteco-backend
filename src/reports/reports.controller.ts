import { applyDecorators, Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ReportsService } from './reports.service';
import { parseGroupBy, parsePagination, parseSalesFilters } from './reports.range';

type Query_ = Record<string, string | undefined>;

const q = (name: string) => ApiQuery({ name, required: false, type: String });

/** Fechas YYYY-MM-DD (hora de Bolivia, inclusivas) + filtros de pedido. */
const FilterQueries = () =>
  applyDecorators(
    q('from'),
    q('to'),
    q('session_id'),
    q('channel'),
    q('payment_method'),
    q('payment_status'),
    q('status'),
    q('delivery_type'),
    q('sold'),
  );

/**
 * Solo lectura y solo admin. El `@Query() query` sin DTO es a propósito: el
 * ValidationPipe global es forbidNonWhitelisted, así que los filtros se
 * validan a mano en reports.range.ts (errores de dominio 400 uniformes).
 */
@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('kpis')
  @Roles('admin', 'cashier', 'kitchen')
  @FilterQueries()
  getKpis(@Query() query: Query_) {
    return this.reports.getKpis(parseSalesFilters(query));
  }

  @Get('sales/timeseries')
  @Roles('admin', 'cashier', 'kitchen')
  @FilterQueries()
  @ApiQuery({ name: 'group_by', required: false, enum: ['day', 'hour'] })
  getTimeseries(@Query() query: Query_) {
    return this.reports.getTimeseries(parseSalesFilters(query), parseGroupBy(query.group_by));
  }

  // Estas dos rutas también las usa el cajero desde "Ventas del día" (POS)
  // para reimprimir un ticket o ver el detalle de una venta de su propio
  // turno — el resto del módulo (KPIs, gráficos, top productos) sigue solo
  // para admin.
  @Get('sales/orders')
  @Roles('admin', 'cashier')
  @FilterQueries()
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  listOrders(@Query() query: Query_) {
    const { limit, offset } = parsePagination(query.limit, query.offset);
    return this.reports.listOrders(parseSalesFilters(query), limit, offset);
  }

  @Get('sales/orders/:id')
  @Roles('admin', 'cashier')
  getOrderDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.getOrderDetail(id);
  }

  @Get('products/top')
  @Roles('admin', 'cashier', 'kitchen')
  @FilterQueries()
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getTopProducts(@Query() query: Query_) {
    const { limit } = parsePagination(query.limit, undefined, 10, 100);
    return this.reports.getTopProducts(parseSalesFilters(query), limit);
  }

  @Get('cash-sessions')
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  listCashSessions(@Query() query: Query_) {
    const { limit, offset } = parsePagination(query.limit, query.offset);
    return this.reports.listCashSessions(query.from, query.to, limit, offset);
  }
}
