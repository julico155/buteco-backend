#!/usr/bin/env node
/**
 * Carga del catálogo REAL de la carta de Buteco en Central, por la API admin (sin tocar la base, sin SSH).
 *
 *   Ver el plan (no escribe nada, es el modo por defecto):
 *     CENTRAL_URL=https://… CENTRAL_ADMIN_USER=… CENTRAL_ADMIN_PASSWORD=… node scripts/load-carta.mjs
 *     (equivale a agregar --dry-run)
 *
 *   Cargar de verdad (solo después de revisar el plan y aprobarlo):
 *     … node scripts/load-carta.mjs --apply
 *
 *   Opciones:
 *     --dry-run           Solo lee y muestra la tabla de lo que crearía / actualizaría / desactivaría. Es el valor por defecto.
 *     --apply             Escribe. Sin esta bandera NUNCA se escribe nada.
 *     --prep-file=ruta    JSON { "codigo-del-producto": minutos | null } con los tiempos de preparación definidos por el dueño;
 *                         pisa los valores por defecto (ver PREP_POR_DEFECTO). Un código que no existe en la carta es un error.
 *     --help
 *
 * Variables de entorno (nunca van en el archivo ni en el repo):
 *   CENTRAL_URL             URL base de Central, sin barra final (ej. https://bkdbuteco.188-245-29-18.sslip.io).
 *   CENTRAL_ADMIN_USER      Usuario con rol admin.
 *   CENTRAL_ADMIN_PASSWORD  Su contraseña.
 *
 * Qué hace y qué NO hace:
 *   - Idempotente por `code`: crea lo que falta, actualiza solo lo que difiere y deja igual lo que ya está. Se puede correr varias veces.
 *   - Crea las categorías "Para compartir" y "Extras" si faltan.
 *   - Reemplaza los grupos de opciones con PUT /products/:id/option-groups (los ids se conservan por `code`) y CONSERVA el estado
 *     "agotado" de una carne marcado a mano en la cocina.
 *   - DESACTIVA (isActive=false) los productos viejos que el negocio quiere retirar (LEGADOS). Nunca borra: la API no tiene DELETE
 *     y borrar rompería el historial. No toca ningún otro producto.
 *   - NO toca ajustes operativos, caja, coordenadas, métodos de pago ni las categorías de prueba ("Prueba", "Pruebas"), ni el
 *     producto de prueba de Bs 0,01.
 *
 * Fuente de los datos: precios, carnes, personas y tamaños del volante del cliente (transcritos y confirmados por GRAD, ver
 * docs/menu-carta-cambios-central.md del repo Agente-Buteco). Los precios de las bebidas NO salen en el volante: el plan los marca
 * "precio por confirmar".
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ── Datos de la carta ────────────────────────────────────────────────────────────────────────────────────

/** Las 6 carnes del restaurante. El `code` es el contrato con el menú (qué recorte dibujar). */
export const CARNES = [
  { code: 'pollo', name: 'Pollo' },
  { code: 'chancho', name: 'Chancho' },
  { code: 'costilla-res', name: 'Costilla de res' },
  { code: 'keperi', name: 'Keperí' },
  { code: 'cola-de-lagarto', name: 'Cola de lagarto' },
  { code: 'pescado', name: 'Pescado' },
];

/** Categorías que usa la carta (el menú reparte los productos por NOMBRE de categoría). */
export const CATEGORIAS = [
  { name: 'Tablitas', sortOrder: 1 },
  { name: 'Para compartir', sortOrder: 2 },
  { name: 'Bebidas', sortOrder: 3 },
  { name: 'Extras', sortOrder: 4 },
];

/** Del volante: tablitas "30 a 40 minutos" -> 40 (límite alto); tablas para compartir "45 a 1 hora" -> 60. Bebidas y extras: sin tiempo. */
export const PREP_POR_DEFECTO = { tablita: 40, tabla: 60 };

const TABLITAS = [
  { code: 'tablita-pollo', name: 'Tablita de pollo', price: 50, dosPersonas: 50 }, // 50 / 100
  { code: 'tablita-chancho', name: 'Tablita de chancho', price: 70, dosPersonas: 40 }, // 70 / 110
  { code: 'tablita-pescado', name: 'Tablita de pescado', price: 75, dosPersonas: 45 }, // 75 / 120
  { code: 'tablita-costilla-res', name: 'Tablita de costilla de res', price: 75, dosPersonas: 45 }, // 75 / 120
  { code: 'tablita-cola-de-lagarto', name: 'Tablita de cola de lagarto', price: 75, dosPersonas: 45 }, // 75 / 120
  { code: 'tablita-keperi', name: 'Tablita de keperí', price: 70 }, // un solo tamaño
  { code: 'tablita-alitas-agridulce', name: 'Tablita de alitas agridulce', price: 60 }, // un solo tamaño
];

const TABLAS = [
  { code: 'tabla-zeus', name: 'Tabla de Zeus', price: 175, carnes: 2, serves: '2 a 3 personas' },
  { code: 'tabla-hercules', name: 'Tabla Hércules', price: 250, carnes: 3, serves: '3 a 4 personas' },
  { code: 'tabla-spartacus', name: 'Tabla Spartacus', price: 350, carnes: 3, serves: '4 a 5 personas' },
  { code: 'tabla-dioses', name: 'Tabla de los Dioses', price: 450, carnes: 4, serves: '5 a 8 personas' },
  { code: 'super-tabla-l', name: 'Super Tabla L', price: 950, carnes: 5, serves: '15 a 17 personas' },
  { code: 'super-tabla-xl', name: 'Super Tabla XL', price: 1600, carnes: 7, serves: '20 a 30 personas' },
];

// Estas bebidas NO salen en las imágenes del volante: los precios vienen de docs/menu-carta-cambios-central.md y hay que confirmarlos.
const BEBIDAS = [
  { code: 'limonada', name: 'Limonada', price: 15, dosLitros: 10 },
  { code: 'maracuya', name: 'Maracuyá', price: 15, dosLitros: 15 },
  { code: 'copuazu', name: 'Copuazú', price: 25, dosLitros: 10 },
  { code: 'coca-cola-2l', name: 'Coca-Cola 2 L', price: 25 },
  { code: 'vino', name: 'Vino', price: 60 },
  { code: 'copo-sujo', name: 'Copo sujo', price: 25 },
];

/** Productos viejos que el negocio quiere retirar: se DESACTIVAN (nunca se borran). Se buscan por nombre exacto, sin mayúsculas. */
export const LEGADOS = ['Tablita Mixta', 'Tablita de Pollo', 'Tablita Familiar', 'Coca-Cola 500ml', 'Cerveza Paceña', 'Jugo de Naranja'];

const grupoTamano = (opciones) => [
  {
    code: 'tamano',
    name: 'Tamaño',
    minSelect: 1,
    maxSelect: 1,
    showInNotice: true, // el aviso a repartidores dice «(1 persona)» / «(2 personas)»
    options: opciones,
  },
];

/** Arma la carta deseada. `prep` pisa los tiempos por defecto: { code: minutos | null }. */
export function buildDesired(prep = {}) {
  const products = [];
  const push = (product) => products.push({ servesLabel: null, prepMinutes: null, availableWeekdays: null, groups: [], notes: [], ...product });

  for (const t of TABLITAS) {
    push({
      code: t.code,
      name: t.name,
      category: 'Tablitas',
      price: t.price,
      prepMinutes: PREP_POR_DEFECTO.tablita,
      groups: t.dosPersonas
        ? grupoTamano([
            { code: '1-persona', name: '1 persona', priceDelta: 0 },
            { code: '2-personas', name: '2 personas', priceDelta: t.dosPersonas },
          ])
        : [],
    });
  }
  for (const t of TABLAS) {
    push({
      code: t.code,
      name: t.name,
      category: 'Para compartir',
      price: t.price,
      servesLabel: t.serves,
      prepMinutes: PREP_POR_DEFECTO.tabla,
      // Un grupo por carne: la misma carne se puede repetir en dos grupos.
      groups: Array.from({ length: t.carnes }, (_, i) => ({
        code: `carne-${i + 1}`,
        name: `Carne ${i + 1}`,
        minSelect: 1,
        maxSelect: 1,
        showInNotice: false,
        options: CARNES.map((c) => ({ code: c.code, name: c.name, priceDelta: 0 })),
      })),
    });
  }
  for (const b of BEBIDAS) {
    push({
      code: b.code,
      name: b.name,
      category: 'Bebidas',
      price: b.price,
      notes: ['precio por confirmar (no sale en el volante)'],
      groups: b.dosLitros
        ? grupoTamano([
            { code: '1-l', name: '1 L', priceDelta: 0 },
            { code: '2-l', name: '2 L', priceDelta: b.dosLitros },
          ])
        : [],
    });
  }
  push({ code: 'sopa-mani', name: 'Sopa de maní', category: 'Extras', price: 15, availableWeekdays: [6, 0] }); // solo sábado y domingo

  products.forEach((p, index) => {
    p.sortOrder = index + 1;
    if (Object.prototype.hasOwnProperty.call(prep, p.code)) p.prepMinutes = prep[p.code];
  });
  const unknown = Object.keys(prep).filter((code) => !products.some((p) => p.code === code));
  if (unknown.length > 0) throw new Error(`--prep-file menciona códigos que no están en la carta: ${unknown.join(', ')}`);
  return { categories: CATEGORIAS, products };
}

// ── Plan (funciones puras: no hacen red) ─────────────────────────────────────────────────────────────────

const norm = (s) => String(s ?? '').trim().toLowerCase();
const sameDays = (a, b) => {
  if (a == null || b == null) return a == null && b == null;
  return JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));
};

/** Grupos deseados en el formato del PUT, conservando `isAvailable` de las opciones que ya existen (carne agotada en cocina). */
export function groupsPayload(desiredGroups, existingGroups = []) {
  return desiredGroups.map((group) => {
    const current = existingGroups.find((g) => g.code === group.code);
    return {
      code: group.code,
      name: group.name,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      showInNotice: group.showInNotice,
      options: group.options.map((option) => ({
        code: option.code,
        name: option.name,
        priceDelta: option.priceDelta,
        isAvailable: current?.options?.find((o) => o.code === option.code)?.isAvailable ?? true,
      })),
    };
  });
}

/** ¿Difieren los grupos deseados de los actuales? (orden, nombres, límites, deltas y opciones; la disponibilidad no cuenta). */
export function groupsDiffer(desiredGroups, existingGroups = []) {
  const shape = (groups) =>
    JSON.stringify(
      groups.map((g) => [
        g.code,
        g.name,
        g.minSelect,
        g.maxSelect,
        Boolean(g.showInNotice),
        g.options.map((o) => [o.code, o.name, Number(o.priceDelta)]),
      ]),
    );
  return shape(desiredGroups) !== shape(existingGroups);
}

/**
 * Compara lo deseado con lo que hay en Central y devuelve el plan. `categories` y `products` son las respuestas de
 * GET /categories?includeInactive=true y GET /products?includeInactive=true.
 */
export function buildPlan({ desired, categories, products }) {
  const categoryByName = new Map(categories.map((c) => [norm(c.name), c]));
  const productByCode = new Map(products.map((p) => [p.code, p]));
  const desiredCodes = new Set(desired.products.map((p) => p.code));

  const categoryActions = desired.categories.map((c) => {
    const found = categoryByName.get(norm(c.name));
    return found
      ? { action: found.isActive === false ? 'update' : 'same', name: c.name, id: found.id, reactivate: found.isActive === false }
      : { action: 'create', name: c.name, sortOrder: c.sortOrder };
  });
  const categoryAction = (name) => categoryActions.find((c) => norm(c.name) === norm(name));

  const productActions = desired.products.map((want) => {
    const current = productByCode.get(want.code);
    const category = categoryAction(want.category);
    if (!current) {
      return { action: 'create', want, changes: ['alta nueva'], groups: groupsPayload(want.groups) };
    }
    const changes = [];
    if (current.name !== want.name) changes.push(`nombre «${current.name}» → «${want.name}»`);
    if (Number(current.price) !== want.price) changes.push(`precio ${current.price} → ${want.price}`);
    if (category.action === 'create' || current.categoryId !== category.id) changes.push(`categoría → ${want.category}`);
    if (current.isActive !== true) changes.push('reactivar (isActive=true)');
    if (current.sortOrder !== want.sortOrder) changes.push(`orden ${current.sortOrder} → ${want.sortOrder}`);
    if ((current.servesLabel ?? null) !== want.servesLabel) changes.push(`personas ${current.servesLabel ?? '—'} → ${want.servesLabel ?? '—'}`);
    if ((current.prepMinutes ?? null) !== want.prepMinutes) changes.push(`prepMinutes ${current.prepMinutes ?? '—'} → ${want.prepMinutes ?? '—'}`);
    if (!sameDays(current.availableWeekdays, want.availableWeekdays)) {
      changes.push(`días ${JSON.stringify(current.availableWeekdays)} → ${JSON.stringify(want.availableWeekdays)}`);
    }
    const regroup = groupsDiffer(want.groups, current.optionGroups ?? []);
    if (regroup) changes.push(`grupos de opciones (${want.groups.length})`);
    return {
      action: changes.length === 0 ? 'same' : 'update',
      want,
      current,
      changes,
      patch: changes.some((c) => !c.startsWith('grupos')) ? true : false,
      regroup,
      groups: groupsPayload(want.groups, current.optionGroups ?? []),
    };
  });

  // Productos viejos a desactivar: por nombre, entre los que NO son de la carta nueva (el "Tablita de Pollo" viejo comparte nombre
  // con el nuevo "Tablita de pollo", pero tiene otro code).
  const legacy = LEGADOS.map((name) => {
    const matches = products.filter((p) => norm(p.name) === norm(name) && !desiredCodes.has(p.code));
    if (matches.length === 0) return { name, action: 'missing' };
    return matches.map((p) => ({ name, product: p, action: p.isActive ? 'deactivate' : 'already-inactive' }));
  }).flat();
  const deactivatingIds = new Set(legacy.filter((l) => l.action === 'deactivate').map((l) => l.product.id));

  // Lo demás que sigue activo y no es de la carta: se informa si se vería en el menú (por el nombre de su categoría).
  const menuCategoryNames = new Set(CATEGORIAS.map((c) => norm(c.name)));
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const others = products
    .filter((p) => p.isActive && !desiredCodes.has(p.code) && !deactivatingIds.has(p.id))
    .map((p) => {
      const categoryName = categoryNameById.get(p.categoryId) ?? '(sin categoría)';
      return { product: p, categoryName, visible: menuCategoryNames.has(norm(categoryName)) };
    });

  return { categoryActions, productActions, legacy, others };
}

// ── Presentación ─────────────────────────────────────────────────────────────────────────────────────────

export function renderTable(columns, rows) {
  const cells = rows.map((row) => columns.map((c) => String(row[c.key] ?? '')));
  const widths = columns.map((c, i) => Math.max(c.title.length, ...cells.map((r) => r[i].length)));
  const line = (parts) => parts.map((p, i) => p.padEnd(widths[i])).join('  │  ').trimEnd();
  return [line(columns.map((c) => c.title)), widths.map((w) => '─'.repeat(w)).join('──┼──'), ...cells.map(line)].join('\n');
}

const LABEL = { create: 'CREAR', update: 'ACTUALIZAR', same: 'sin cambios', deactivate: 'DESACTIVAR', 'already-inactive': 'ya inactivo', missing: 'no encontrado' };

export function printPlan(plan) {
  const out = [];
  out.push('\nCATEGORÍAS');
  out.push(renderTable([{ key: 'accion', title: 'Acción' }, { key: 'name', title: 'Categoría' }], plan.categoryActions.map((c) => ({ accion: LABEL[c.action], name: c.name }))));

  out.push('\nPRODUCTOS DE LA CARTA');
  out.push(
    renderTable(
      [
        { key: 'accion', title: 'Acción' },
        { key: 'code', title: 'code' },
        { key: 'name', title: 'Nombre' },
        { key: 'price', title: 'Precio' },
        { key: 'categoria', title: 'Categoría' },
        { key: 'detalle', title: 'Detalle' },
      ],
      plan.productActions.map((a) => {
        const w = a.want;
        const extras = [];
        if (w.groups.length > 0) {
          const first = w.groups[0];
          extras.push(w.groups.length === 1 ? `${first.name}: ${first.options.map((o) => o.name + (o.priceDelta ? ` +${o.priceDelta}` : '')).join(' / ')}` : `${w.groups.length} grupos de carne (${first.options.length} opciones)`);
        }
        if (w.servesLabel) extras.push(w.servesLabel);
        extras.push(w.prepMinutes == null ? 'sin prepMinutes' : `prep ${w.prepMinutes} min`);
        if (w.availableWeekdays) extras.push(`solo días ${JSON.stringify(w.availableWeekdays)} (0=dom, 6=sáb)`);
        extras.push(...w.notes.map((n) => n.toUpperCase()));
        if (a.action === 'update') extras.push(`CAMBIOS: ${a.changes.join('; ')}`);
        return { accion: LABEL[a.action], code: w.code, name: w.name, price: w.price, categoria: w.category, detalle: extras.join(' · ') };
      }),
    ),
  );

  out.push('\nPRODUCTOS VIEJOS A DESACTIVAR (no se borran)');
  out.push(
    renderTable(
      [{ key: 'accion', title: 'Acción' }, { key: 'name', title: 'Nombre' }, { key: 'code', title: 'code' }, { key: 'price', title: 'Precio' }],
      plan.legacy.map((l) => ({ accion: LABEL[l.action], name: l.name, code: l.product?.code ?? '', price: l.product?.price ?? '' })),
    ),
  );

  out.push('\nOTROS PRODUCTOS ACTIVOS QUE EL SCRIPT NO TOCA');
  out.push(
    plan.others.length === 0
      ? '(ninguno)'
      : renderTable(
          [{ key: 'name', title: 'Nombre' }, { key: 'code', title: 'code' }, { key: 'price', title: 'Precio' }, { key: 'categoryName', title: 'Categoría' }, { key: 'vista', title: '¿Se ve en la carta?' }],
          plan.others.map((o) => ({ name: o.product.name, code: o.product.code, price: o.product.price, categoryName: o.categoryName, vista: o.visible ? 'SÍ (decidir)' : 'no' })),
        ),
  );

  const count = (list, action) => list.filter((x) => x.action === action).length;
  out.push(
    `\nRESUMEN: categorías a crear ${count(plan.categoryActions, 'create')}; productos a crear ${count(plan.productActions, 'create')}, a actualizar ${count(plan.productActions, 'update')}, sin cambios ${count(plan.productActions, 'same')}; a desactivar ${count(plan.legacy, 'deactivate')}.`,
  );
  const porConfirmar = plan.productActions.filter((a) => a.want.notes.length > 0).map((a) => a.want.name);
  if (porConfirmar.length > 0) out.push(`PRECIO POR CONFIRMAR (no sale en el volante): ${porConfirmar.join(', ')}.`);
  out.push('prepMinutes del volante: tablitas "30 a 40 minutos" → 40; tablas para compartir "45 a 1 hora" → 60; bebidas y sopa sin tiempo. El campo admite un solo número.');
  console.log(out.join('\n'));
}

// ── Aplicar ──────────────────────────────────────────────────────────────────────────────────────────────

export async function applyPlan(api, plan) {
  const categoryIds = new Map();
  for (const c of plan.categoryActions) {
    if (c.action === 'create') {
      const created = await api.post('/categories', { name: c.name, sortOrder: c.sortOrder });
      categoryIds.set(norm(c.name), created.id);
      console.log(`  categoría creada: ${c.name}`);
    } else {
      if (c.reactivate) {
        await api.patch(`/categories/${c.id}`, { isActive: true });
        console.log(`  categoría reactivada: ${c.name}`);
      }
      categoryIds.set(norm(c.name), c.id);
    }
  }

  for (const a of plan.productActions) {
    const w = a.want;
    const categoryId = categoryIds.get(norm(w.category));
    if (a.action === 'create') {
      const created = await api.post('/products', {
        code: w.code,
        name: w.name,
        categoryId,
        price: w.price,
        isActive: true,
        sortOrder: w.sortOrder,
        ...(w.servesLabel ? { servesLabel: w.servesLabel } : {}),
        ...(w.prepMinutes != null ? { prepMinutes: w.prepMinutes } : {}),
        ...(w.availableWeekdays ? { availableWeekdays: w.availableWeekdays } : {}),
      });
      if (a.groups.length > 0) await api.put(`/products/${created.id}/option-groups`, { groups: a.groups });
      console.log(`  creado: ${w.code}`);
    } else if (a.action === 'update') {
      if (a.patch) {
        await api.patch(`/products/${a.current.id}`, {
          name: w.name,
          price: w.price,
          categoryId,
          isActive: true,
          sortOrder: w.sortOrder,
          servesLabel: w.servesLabel,
          prepMinutes: w.prepMinutes,
          availableWeekdays: w.availableWeekdays,
        });
      }
      if (a.regroup) await api.put(`/products/${a.current.id}/option-groups`, { groups: a.groups });
      console.log(`  actualizado: ${w.code} (${a.changes.join('; ')})`);
    }
  }

  for (const l of plan.legacy) {
    if (l.action !== 'deactivate') continue;
    await api.patch(`/products/${l.product.id}`, { isActive: false });
    console.log(`  desactivado: ${l.product.name} (${l.product.code})`);
  }
}

// ── Cliente HTTP y main ──────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const flags = { apply: false, dryRun: false, help: false, prepFile: null };
  for (const arg of argv) {
    if (arg === '--apply') flags.apply = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--prep-file=')) flags.prepFile = arg.slice('--prep-file='.length);
    else throw new Error(`Opción desconocida: ${arg} (usa --help)`);
  }
  if (flags.apply && flags.dryRun) throw new Error('--apply y --dry-run son excluyentes.');
  return flags;
}

async function login(baseUrl, user, password) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  });
  if (!response.ok) throw new Error(`No se pudo iniciar sesión como "${user}" (HTTP ${response.status}). Revisa usuario y contraseña.`);
  const body = await response.json();
  if (!body.accessToken) throw new Error('Central no devolvió accessToken.');
  return body.accessToken;
}

function client(baseUrl, token) {
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b) };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  const missing = ['CENTRAL_URL', 'CENTRAL_ADMIN_USER', 'CENTRAL_ADMIN_PASSWORD'].filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`Faltan variables de entorno: ${missing.join(', ')} (usa --help).`);
  const baseUrl = process.env.CENTRAL_URL.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('CENTRAL_URL debe empezar con http:// o https://');

  const prep = flags.prepFile ? JSON.parse(readFileSync(flags.prepFile, 'utf8')) : {};
  const desired = buildDesired(prep);

  console.log(`Destino : ${baseUrl}`);
  console.log(`Modo    : ${flags.apply ? 'APPLY (ESCRIBE en Central)' : 'DRY-RUN (solo lee, no escribe nada)'}`);
  console.log(`Usuario : ${process.env.CENTRAL_ADMIN_USER}`);

  const token = await login(baseUrl, process.env.CENTRAL_ADMIN_USER, process.env.CENTRAL_ADMIN_PASSWORD);
  const api = client(baseUrl, token);
  const [categories, products] = await Promise.all([api.get('/categories?includeInactive=true'), api.get('/products?includeInactive=true')]);
  const plan = buildPlan({ desired, categories, products });
  printPlan(plan);

  if (!flags.apply) {
    console.log('\nDRY-RUN: no se escribió nada. Para cargar de verdad, revisa la tabla y vuelve a correr con --apply.');
    return;
  }
  console.log('\nAplicando…');
  await applyPlan(api, plan);
  const after = await api.get('/products?includeInactive=true');
  const byCode = new Map(after.map((p) => [p.code, p]));
  const missingAfter = desired.products.filter((p) => !byCode.has(p.code));
  console.log(`\nListo. ${desired.products.length - missingAfter.length}/${desired.products.length} productos de la carta presentes.`);
  if (missingAfter.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nERROR: ${error.message}`);
    process.exit(1);
  });
}
