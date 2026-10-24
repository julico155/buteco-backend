// Pruebas del plan de carga (sin red ni base): node --test scripts/load-carta.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDesired, buildPlan, groupsDiffer, groupsPayload, LEGADOS, parseArgs, renderTable } from './load-carta.mjs';

const desired = () => buildDesired();
const category = (id, name, isActive = true) => ({ id, name, isActive });

/** Lo que hoy hay en producción según la revisión de solo lectura (sin los grupos nuevos). */
const productionLike = () => ({
  categories: [category('c-prueba', 'Prueba'), category('c-tab', 'Tablitas'), category('c-beb', 'Bebidas'), category('c-ent', 'Entradas'), category('c-pru', 'Pruebas')],
  products: [
    { id: 'p1', code: 'TAB-001', name: 'Tablita Mixta', price: 85, isActive: true, categoryId: 'c-tab', optionGroups: [] },
    { id: 'p2', code: 'TAB-002', name: 'Tablita de Pollo', price: 70, isActive: true, categoryId: 'c-tab', optionGroups: [] },
    { id: 'p3', code: 'TAB-003', name: 'Tablita Familiar', price: 160, isActive: true, categoryId: 'c-tab', optionGroups: [] },
    { id: 'p4', code: 'BEB-001', name: 'Coca-Cola 500ml', price: 10, isActive: true, categoryId: 'c-beb', optionGroups: [] },
    { id: 'p5', code: 'BEB-002', name: 'Cerveza Paceña', price: 20, isActive: true, categoryId: 'c-beb', optionGroups: [] },
    { id: 'p6', code: 'BEB-003', name: 'Jugo de Naranja', price: 12, isActive: true, categoryId: 'c-beb', optionGroups: [] },
    { id: 'p7', code: 'PRUEBA-001', name: 'Producto de prueba Bs 0,01', price: 0.01, isActive: true, categoryId: 'c-prueba', optionGroups: [] },
    { id: 'p8', code: 'ENT-001', name: 'Alitas', price: 30, isActive: true, categoryId: 'c-ent', optionGroups: [] },
  ],
});

test('la carta tiene 7 tablitas, 6 tablas, 6 bebidas y la sopa con el contrato que espera el menú', () => {
  const { products } = desired();
  assert.equal(products.length, 7 + 6 + 6 + 1);
  assert.deepEqual(
    products.filter((p) => p.category === 'Tablitas').map((p) => [p.code, p.price]),
    [['tablita-pollo', 50], ['tablita-chancho', 70], ['tablita-pescado', 75], ['tablita-costilla-res', 75], ['tablita-cola-de-lagarto', 75], ['tablita-keperi', 70], ['tablita-alitas-agridulce', 60]],
  );
  const pollo = products.find((p) => p.code === 'tablita-pollo');
  assert.equal(pollo.groups[0].code, 'tamano');
  assert.equal(pollo.groups[0].showInNotice, true);
  assert.deepEqual(pollo.groups[0].options.map((o) => [o.name, o.priceDelta]), [['1 persona', 0], ['2 personas', 50]]);
  // Precio de 2 personas del volante = base + delta
  const dosPersonas = Object.fromEntries(products.filter((p) => p.code.startsWith('tablita-') && p.groups.length).map((p) => [p.code, p.price + p.groups[0].options[1].priceDelta]));
  assert.deepEqual(dosPersonas, { 'tablita-pollo': 100, 'tablita-chancho': 110, 'tablita-pescado': 120, 'tablita-costilla-res': 120, 'tablita-cola-de-lagarto': 120 });
  assert.equal(products.find((p) => p.code === 'tablita-keperi').groups.length, 0);
  assert.equal(products.find((p) => p.code === 'tablita-alitas-agridulce').groups.length, 0);

  const xl = products.find((p) => p.code === 'super-tabla-xl');
  assert.equal(xl.price, 1600);
  assert.equal(xl.servesLabel, '20 a 30 personas');
  assert.equal(xl.groups.length, 7);
  assert.deepEqual(xl.groups[0].options.map((o) => o.code), ['pollo', 'chancho', 'costilla-res', 'keperi', 'cola-de-lagarto', 'pescado']);
  assert.deepEqual(products.filter((p) => p.category === 'Para compartir').map((p) => [p.price, p.groups.length]), [[175, 2], [250, 3], [350, 3], [450, 4], [950, 5], [1600, 7]]);

  const sopa = products.find((p) => p.code === 'sopa-mani');
  assert.deepEqual(sopa.availableWeekdays, [6, 0]);
  assert.equal(sopa.prepMinutes, null);
});

test('prepMinutes por defecto: 40 en tablitas, 60 en tablas, nada en bebidas; --prep-file los pisa y rechaza códigos inexistentes', () => {
  const { products } = desired();
  assert.ok(products.filter((p) => p.category === 'Tablitas').every((p) => p.prepMinutes === 40));
  assert.ok(products.filter((p) => p.category === 'Para compartir').every((p) => p.prepMinutes === 60));
  assert.ok(products.filter((p) => p.category === 'Bebidas').every((p) => p.prepMinutes === null));
  const custom = buildDesired({ 'tabla-zeus': 50, 'tablita-pollo': null }).products;
  assert.equal(custom.find((p) => p.code === 'tabla-zeus').prepMinutes, 50);
  assert.equal(custom.find((p) => p.code === 'tablita-pollo').prepMinutes, null);
  assert.throws(() => buildDesired({ 'no-existe': 10 }), /no-existe/);
});

test('las bebidas se marcan como precio por confirmar; lo demás no', () => {
  const { products } = desired();
  assert.ok(products.filter((p) => p.category === 'Bebidas').every((p) => p.notes.length === 1));
  assert.ok(products.filter((p) => p.category !== 'Bebidas').every((p) => p.notes.length === 0));
});

test('contra producción: crea las 2 categorías que faltan, todo lo nuevo y desactiva SOLO los 6 viejos', () => {
  const plan = buildPlan({ desired: desired(), ...productionLike() });
  assert.deepEqual(plan.categoryActions.map((c) => [c.name, c.action]), [['Tablitas', 'same'], ['Para compartir', 'create'], ['Bebidas', 'same'], ['Extras', 'create']]);
  assert.ok(plan.productActions.every((a) => a.action === 'create'));
  assert.deepEqual(plan.legacy.map((l) => [l.name, l.action]), LEGADOS.map((name) => [name, 'deactivate']));
  assert.deepEqual(plan.legacy.map((l) => l.product.id).sort(), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
});

test('no toca el producto de prueba, ni las categorías de prueba, ni lo que no está en la lista: solo lo informa', () => {
  const plan = buildPlan({ desired: desired(), ...productionLike() });
  assert.deepEqual(plan.others.map((o) => [o.product.id, o.categoryName, o.visible]), [['p7', 'Prueba', false], ['p8', 'Entradas', false]]);
  assert.ok(!plan.legacy.some((l) => l.product?.id === 'p7'));
});

test('un producto viejo suelto en una categoría de la carta se informa como visible', () => {
  const state = productionLike();
  state.products.push({ id: 'p9', code: 'X-1', name: 'Hamburguesa', price: 30, isActive: true, categoryId: 'c-tab', optionGroups: [] });
  const plan = buildPlan({ desired: desired(), ...state });
  assert.deepEqual(plan.others.find((o) => o.product.id === 'p9'), { product: state.products.at(-1), categoryName: 'Tablitas', visible: true });
});

test('el "Tablita de Pollo" viejo (TAB-002) no se confunde con el nuevo "Tablita de pollo" (tablita-pollo)', () => {
  const state = productionLike();
  state.products.push({ id: 'new', code: 'tablita-pollo', name: 'Tablita de pollo', price: 50, isActive: true, categoryId: 'c-tab', optionGroups: [] });
  const plan = buildPlan({ desired: desired(), ...state });
  const deactivated = plan.legacy.filter((l) => l.action === 'deactivate').map((l) => l.product.code);
  assert.ok(deactivated.includes('TAB-002'));
  assert.ok(!deactivated.includes('tablita-pollo'));
});

test('un legado ya inactivo o ausente no se vuelve a desactivar', () => {
  const state = productionLike();
  state.products[0].isActive = false;
  state.products = state.products.filter((p) => p.name !== 'Jugo de Naranja');
  const plan = buildPlan({ desired: desired(), ...state });
  const byName = Object.fromEntries(plan.legacy.map((l) => [l.name, l.action]));
  assert.equal(byName['Tablita Mixta'], 'already-inactive');
  assert.equal(byName['Jugo de Naranja'], 'missing');
});

test('idempotente: si Central ya tiene la carta cargada, el plan no tiene cambios', () => {
  const want = desired();
  const categories = [category('c-tab', 'Tablitas'), category('c-cmp', 'Para compartir'), category('c-beb', 'Bebidas'), category('c-ext', 'Extras')];
  const idOf = Object.fromEntries(categories.map((c) => [c.name, c.id]));
  const products = want.products.map((p, i) => ({
    id: `id-${i}`,
    code: p.code,
    name: p.name,
    price: p.price,
    isActive: true,
    categoryId: idOf[p.category],
    sortOrder: p.sortOrder,
    servesLabel: p.servesLabel,
    prepMinutes: p.prepMinutes,
    availableWeekdays: p.availableWeekdays,
    optionGroups: p.groups.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o, isAvailable: true })) })),
  }));
  const plan = buildPlan({ desired: want, categories, products });
  assert.ok(plan.categoryActions.every((c) => c.action === 'same'));
  assert.ok(plan.productActions.every((a) => a.action === 'same'), JSON.stringify(plan.productActions.filter((a) => a.action !== 'same').map((a) => [a.want.code, a.changes])));
  assert.deepEqual(plan.legacy.map((l) => l.action), LEGADOS.map(() => 'missing'));
});

test('un cambio de precio o de días se detecta como ACTUALIZAR con el motivo', () => {
  const want = desired();
  const categories = [category('c-tab', 'Tablitas'), category('c-cmp', 'Para compartir'), category('c-beb', 'Bebidas'), category('c-ext', 'Extras')];
  const sopa = want.products.find((p) => p.code === 'sopa-mani');
  const products = [{ id: 's', code: 'sopa-mani', name: sopa.name, price: 12, isActive: true, categoryId: 'c-ext', sortOrder: sopa.sortOrder, servesLabel: null, prepMinutes: null, availableWeekdays: null, optionGroups: [] }];
  const plan = buildPlan({ desired: want, categories, products });
  const action = plan.productActions.find((a) => a.want.code === 'sopa-mani');
  assert.equal(action.action, 'update');
  assert.deepEqual(action.changes, ['precio 12 → 15', 'días null → [6,0]']);
  assert.equal(action.regroup, false);
});

test('volver a cargar CONSERVA la carne marcada como agotada en la cocina', () => {
  const want = desired().products.find((p) => p.code === 'tabla-zeus');
  const existing = want.groups.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o, isAvailable: o.code !== 'pescado' })) }));
  const payload = groupsPayload(want.groups, existing);
  assert.equal(payload[0].options.find((o) => o.code === 'pescado').isAvailable, false);
  assert.equal(payload[0].options.find((o) => o.code === 'pollo').isAvailable, true);
  assert.equal(groupsDiffer(want.groups, existing), false); // la disponibilidad no cuenta como cambio
  const nuevo = groupsPayload(want.groups);
  assert.ok(nuevo.every((g) => g.options.every((o) => o.isAvailable === true)));
});

test('--apply y --dry-run son excluyentes; sin banderas es dry-run; una opción desconocida falla', () => {
  assert.deepEqual(parseArgs([]), { apply: false, dryRun: false, help: false, prepFile: null });
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /excluyentes/);
  assert.throws(() => parseArgs(['--aplicar']), /desconocida/);
  assert.equal(parseArgs(['--prep-file=x.json']).prepFile, 'x.json');
});

test('renderTable alinea columnas', () => {
  const text = renderTable([{ key: 'a', title: 'A' }, { key: 'b', title: 'Bbb' }], [{ a: 'xx', b: 1 }]);
  assert.match(text, /^A {3}│ {2}Bbb/);
});
