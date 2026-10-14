import 'reflect-metadata';
import { ROLES_KEY } from '../auth/roles.decorator';
import { ReportsController } from './reports.controller';

function rolesOf(method: keyof ReportsController): string[] | undefined {
  return Reflect.getMetadata(ROLES_KEY, ReportsController.prototype[method]);
}

describe('ReportsController — roles', () => {
  it('por defecto el módulo es solo admin', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ReportsController)).toEqual(['admin']);
  });

  it('KPIs, serie de ventas y top de productos también los ven caja y cocina', () => {
    for (const method of ['getKpis', 'getTimeseries', 'getTopProducts'] as const) {
      expect(rolesOf(method)).toEqual(['admin', 'cashier', 'kitchen']);
    }
  });

  it('lista y detalle de ventas: admin y caja, no cocina', () => {
    expect(rolesOf('listOrders')).toEqual(['admin', 'cashier']);
    expect(rolesOf('getOrderDetail')).toEqual(['admin', 'cashier']);
  });

  it('el historial de cierres de caja sigue solo para admin (sin override)', () => {
    expect(rolesOf('listCashSessions')).toBeUndefined();
  });
});
