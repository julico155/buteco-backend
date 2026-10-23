import { DomainException } from '../common/exceptions/domain-exception';
import { assertValidOptionGroups, toProductResponse } from './products.service';
import { ReplaceProductOptionGroupsDto } from './dto/product-option-groups.dto';

const row = {
  id: 'p1',
  code: 'sopa-mani',
  name: 'Sopa de maní',
  description: null,
  category_id: 'c1',
  price: '15.00',
  is_active: true,
  is_available: true,
  sort_order: 1,
  image_key: null,
  available_weekdays: [6, 0] as number[] | null,
  serves_label: null,
  prep_minutes: null,
};

describe('toProductResponse — campos nuevos de la carta', () => {
  it('calcula isAvailableToday para el día calendario de La Paz, sin tocar isAvailable (el flag manual)', () => {
    const saturday = new Date('2026-10-24T16:00:00Z');
    const monday = new Date('2026-10-26T16:00:00Z');

    expect(toProductResponse(row, [], [], saturday)).toMatchObject({ isAvailable: true, isAvailableToday: true, availableWeekdays: [6, 0] });
    expect(toProductResponse(row, [], [], monday)).toMatchObject({ isAvailable: true, isAvailableToday: false, availableWeekdays: [6, 0] });
    // Agotado a mano un sábado: isAvailable lo dice; el día no lo pisa.
    expect(toProductResponse({ ...row, is_available: false }, [], [], saturday)).toMatchObject({ isAvailable: false, isAvailableToday: true });
  });

  it('un producto de siempre sale con los campos nuevos en su valor neutro', () => {
    const plain = toProductResponse({ ...row, available_weekdays: null }, [], [], new Date('2026-10-26T16:00:00Z'));
    expect(plain).toMatchObject({
      optionGroups: [],
      availableWeekdays: null,
      isAvailableToday: true,
      servesLabel: null,
      prepMinutes: null,
      complements: [],
    });
  });
});

describe('assertValidOptionGroups', () => {
  const option = (code: string) => ({ code, name: code });
  const dto = (groups: ReplaceProductOptionGroupsDto['groups']): ReplaceProductOptionGroupsDto => ({ groups });
  const codeOf = (fn: () => void): string => {
    try {
      fn();
    } catch (error) {
      return (error as DomainException).code;
    }
    return 'ok';
  };

  it('acepta grupos coherentes (Zeus: dos carnes a elección; tablita: un tamaño)', () => {
    const carnes = ['pollo', 'chancho', 'pescado'].map(option);
    expect(codeOf(() => assertValidOptionGroups(dto([{ code: 'carne-1', name: 'Carne 1', options: carnes }, { code: 'carne-2', name: 'Carne 2', options: carnes }])))).toBe('ok');
    expect(codeOf(() => assertValidOptionGroups(dto([])))).toBe('ok');
  });

  it('rechaza códigos repetidos, min > max y max mayor que la cantidad de opciones', () => {
    const carnes = ['pollo', 'chancho'].map(option);
    expect(codeOf(() => assertValidOptionGroups(dto([{ code: 'g', name: 'G', options: carnes }, { code: 'g', name: 'G2', options: carnes }])))).toBe('validation_error');
    expect(codeOf(() => assertValidOptionGroups(dto([{ code: 'g', name: 'G', options: [option('a'), option('a')] }])))).toBe('validation_error');
    expect(codeOf(() => assertValidOptionGroups(dto([{ code: 'g', name: 'G', minSelect: 2, maxSelect: 1, options: carnes }])))).toBe('validation_error');
    expect(codeOf(() => assertValidOptionGroups(dto([{ code: 'g', name: 'G', maxSelect: 3, options: carnes }])))).toBe('validation_error');
  });
});
