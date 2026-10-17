import { ColumnType, Generated, JSONColumnType } from 'kysely';

/**
 * Tipos de tabla para Kysely. Nombres de columna en snake_case (tal como
 * están en la base) — no se usa el plugin de camelCase para que el SQL
 * crudo y el query builder hablen del mismo nombre siempre.
 *
 * Timestamp y los JSON con default ya declaran su lado de INSERT como
 * opcional dentro del propio ColumnType — a diferencia de columnas planas,
 * NO se envuelven en `Generated<>` (anidar Generated<ColumnType<...>> hace
 * que TS deje de reducir el tipo correctamente en `.set()`/`.values()`).
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type OptionalJsonArray<T> = ColumnType<T, T | string | undefined, T | string>;

export interface CategoriesTable {
  id: Generated<string>;
  name: string;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProductsTable {
  id: Generated<string>;
  code: string;
  name: string;
  description: string | null;
  category_id: string;
  price: string; // numeric(10,2) llega como string del driver pg
  is_active: Generated<boolean>;
  is_available: Generated<boolean>;
  sort_order: Generated<number>;
  image_key: string | null;
  image_mime_type: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CustomersTable {
  id: Generated<string>;
  name: string | null;
  phone: string | null;
  email: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface IdempotencyKeysTable {
  id: Generated<string>;
  api_client: string;
  endpoint: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number | null;
  response_body: JSONColumnType<Record<string, unknown>> | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
}

export type OrderChannel = 'whatsapp' | 'web' | 'pos' | 'external';
/** delivery = a domicilio, pickup = para llevar (retira en el mostrador), dine_in = para comer en el local (mesa). */
export type OrderDeliveryType = 'delivery' | 'pickup' | 'dine_in';
/** 'split' solo se llega a través de POST /orders/:id/split-payment, nunca al crear el pedido. */
export type OrderPaymentMethod = 'qr' | 'cash' | 'split';
/**
 * Qué cubre el QR de un pedido de delivery: solo la comida (el repartidor cobra
 * el envío en efectivo) o comida + envío. null en todo lo demás.
 */
export type QrScope = 'food_only' | 'food_and_delivery';
export type OrderPaymentStatus = 'unpaid' | 'pending_review' | 'paid' | 'rejected';
export type OrderStatus =
  | 'draft'
  | 'awaiting_location'
  /** Cuenta de mesa abierta, todavía sin cobrar (se le agregan rondas). */
  | 'open'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';
export type DeliveryQuoteStatus = 'pending' | 'quoted' | 'pending_manual' | 'failed';

export interface OrdersTable {
  id: Generated<string>;
  /** "Pedido #N" para mostrar/imprimir — reinicia cada apertura de caja, ya NO es único a nivel de base. Lo arma la app, no un default de columna. */
  order_number: string;
  /** Único para siempre — es lo que se manda al banco como transactionId en cada QR real. */
  bank_reference: Generated<string>;
  /** Qué apertura de caja ancla la numeración de order_number de este pedido. */
  numbering_session_id: string | null;
  customer_id: string | null;
  channel: OrderChannel;
  customer_name: string;
  delivery_type: OrderDeliveryType;
  payment_method: OrderPaymentMethod;
  payment_status: Generated<OrderPaymentStatus>;
  notes: string | null;
  status: Generated<OrderStatus>;
  subtotal_amount: string;
  delivery_base_amount: Generated<string>;
  delivery_surcharge_amount: Generated<string>;
  total_amount: string;
  delivery_pricing: 'dynamic' | null;
  delivery_quote_status: DeliveryQuoteStatus | null;
  delivery_distance_meters: number | null;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  /** Triestado: null = nadie decidió (sin override), true = "envío pagado", false = "cobrar envío". */
  delivery_fee_paid: boolean | null;
  delivery_fee_paid_at: Timestamp | null;
  cash_confirmed_at: Timestamp | null;
  /** Solo delivery pagado por QR: qué cubre el QR. Congelado al crear el pedido; null para todo lo demás. */
  qr_scope: QrScope | null;
  /** Solo con payment_method='split': cuánto de la cuenta va en efectivo. */
  split_cash_amount: string | null;
  /** Solo con payment_method='split': cuánto va por QR — split_cash_amount + split_qr_amount = total_amount, siempre. */
  split_qr_amount: string | null;
  /** Confirmación de la pata efectivo de un split — separado de cash_confirmed_at, que es solo para payment_method='cash' puro. */
  split_cash_confirmed_at: Timestamp | null;
  confirmed_at: Timestamp | null;
  status_updated_by: string | null;
  /** Repartidor que aceptó el pedido de delivery (rol `delivery`); null hasta que alguien lo acepta. */
  delivery_driver_id: string | null;
  delivery_driver_name: string | null;
  delivery_accepted_at: Timestamp | null;
  delivered_at: Timestamp | null;
  /** Caja (turno) donde se confirmó el pago — null hasta que se cobra (o al aceptarse, si fue fuera de horario). */
  register_session_id: string | null;
  /** FASE 3 (replace-not-mutate): este pedido reemplaza a ese otro — nunca se editan líneas de un pedido existente. */
  replaces_order_id: string | null;
  /** Inverso de replaces_order_id — null hasta que alguien lo reemplaza; un pedido solo se reemplaza una vez (índice único parcial). */
  replaced_by_order_id: string | null;
  /** Mesa de la cuenta (solo dine_in abierto desde una mesa). */
  table_id: string | null;
  /** "Pidió la cuenta": el plano pinta la mesa como por cobrar. Se borra al agregar una ronda. */
  bill_requested_at: Timestamp | null;
  /** Adelanto de reserva que descuenta esta cuenta. subtotal/total ya vienen netos de este crédito. */
  deposit_credit_amount: Generated<string>;
  /** Pedido que representa el adelanto de una reserva (no es una venta de comida). */
  reservation_deposit: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrderItemsTable {
  id: Generated<string>;
  order_id: string;
  product_id: string;
  product_code_snapshot: string;
  product_name_snapshot: string;
  unit_price_snapshot: string;
  quantity: number;
  subtotal: string;
  /** Snapshot de nombres de complementos excluidos en esta línea (ej. ["cebolla"]) — nunca un id, ver migración. */
  excluded_complements: string[];
  created_at: Timestamp;
  /** Ronda de la cuenta de mesa en la que se agregó la línea (1 para pedidos normales). */
  round_number: Generated<number>;
  added_at: Timestamp;
  /** Anulada: se conserva con quién y por qué, pero no cuenta en total ni comanda. */
  voided_at: Timestamp | null;
  voided_by: string | null;
  void_reason: string | null;
}

export interface ProductComplementsTable {
  id: Generated<string>;
  product_id: string;
  name: string;
  sort_order: Generated<number>;
  created_at: Timestamp;
}

export type LateOrderRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface LateOrderRequestsTable {
  id: Generated<string>;
  request_number: Generated<string>;
  customer_id: string | null;
  customer_name: string;
  channel: OrderChannel;
  delivery_type: OrderDeliveryType;
  payment_method: OrderPaymentMethod;
  qr_scope: QrScope | null;
  notes: string | null;
  items_json: JSONColumnType<unknown[]>;
  promotions_json: OptionalJsonArray<unknown[]>;
  subtotal_amount: string;
  /**
   * Ubicación que mandó el checkout web (solo `channel` web/whatsapp + delivery). Ambas o ninguna. Se aplica y cotiza al ACEPTAR la
   * solicitud, en la misma transacción que crea el pedido. Migraciones 1700000013000 y 1700000014000.
   */
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  idempotency_key: string;
  status: Generated<LateOrderRequestStatus>;
  requested_at: Timestamp;
  expires_at: Timestamp;
  decided_at: Timestamp | null;
  decided_by: string | null;
  order_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** 'none' = el QR (si lo hay) cubre todo el total: presencial, o cualquier método que no sea QR. */
export type PaymentOptionQrScope = 'none' | QrScope;

export interface PaymentOptionsTable {
  service_type: OrderDeliveryType;
  payment_method: OrderPaymentMethod;
  qr_scope: PaymentOptionQrScope;
  enabled: boolean;
  /** Canales de origen que pueden usar esta forma de pago (siempre al menos uno). */
  channels: Generated<OrderChannel[]>;
  updated_at: Timestamp;
  updated_by: string | null;
}

/** Contador de pedidos por día de negocio, para numerar cuando no se usa caja. */
export interface OrderDayCountersTable {
  day: string;
  last_number: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface DeliveryTariffBandsTable {
  band_index: number;
  max_distance_meters: number;
  fee_amount: string;
}

export type DeliveryQuoteRequestStatus = 'quoted' | 'manual_quote' | 'failed';

export interface DeliveryQuoteRequestsTable {
  id: Generated<string>;
  customer_id: string | null;
  idempotency_key: string;
  latitude: number;
  longitude: number;
  status: DeliveryQuoteRequestStatus;
  distance_meters: number | null;
  distance_source: 'mapbox' | 'straight_line' | 'reused' | null;
  fee_amount: string | null;
  /** Recargo por lluvia vigente al cotizar; null en filas viejas (= sin recargo). */
  surcharge_amount: string | null;
  error_code: string | null;
  created_at: Timestamp;
}

export type PaymentAttemptReviewStatus = 'pending_review' | 'accepted' | 'rejected';

export interface PaymentAttemptsTable {
  id: Generated<string>;
  order_id: string;
  customer_id: string | null;
  opened_at: Timestamp;
  opened_as: Generated<'normal' | 'late'>;
  review_status: Generated<PaymentAttemptReviewStatus>;
  reviewed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * `paid_unapplied`: el banco confirmó el pago pero no se pudo aplicar al
 * pedido (caja cerrada). La plata está cobrada y espera decisión humana —
 * aplicarla o devolverla (`refunded`, siempre manual: el banco no expone
 * API de devolución).
 */
export type BankQrChargeStatus =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'paid_unapplied'
  | 'refunded';

/**
 * QR real de Banco Económico, 1 a 1 con un payment_attempt (el que ya trae
 * el CAS de decide(), el vínculo a caja y la notificación al cliente — acá
 * solo vive el detalle bancario que ese modelo no necesita conocer).
 */
export interface BankQrChargesTable {
  id: Generated<string>;
  order_id: string;
  payment_attempt_id: string;
  qr_id: string;
  transaction_id: string;
  amount: string;
  due_date: ColumnType<string, string, string>;
  status: Generated<BankQrChargeStatus>;
  qr_image_base64: string;
  raw_generate_response: JSONColumnType<Record<string, unknown>> | null;
  raw_status_response: JSONColumnType<Record<string, unknown>> | null;
  raw_notify_payload: JSONColumnType<Record<string, unknown>> | null;
  /** Primera vez que el banco lo reportó pagado sin poder aplicarlo — ancla del margen de gracia. */
  paid_detected_at: Timestamp | null;
  resolution_notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type CashRegisterSessionStatus = 'open' | 'closed';

/**
 * Caja (turno). Una sola fila `status='open'` a la vez (índice único
 * parcial en la migración) — cubre efectivo y QR por igual, no solo plata
 * física: agrupa cualquier pedido confirmado pagado durante la sesión.
 */
export interface CashRegisterSessionsTable {
  id: Generated<string>;
  status: Generated<CashRegisterSessionStatus>;
  opened_at: Timestamp;
  opened_by: string;
  opening_amount: string;
  closed_at: Timestamp | null;
  closed_by: string | null;
  counted_cash_amount: string | null;
  expected_cash_amount: string | null;
  cash_difference: string | null;
  total_cash_sales_amount: string | null;
  total_qr_sales_amount: string | null;
  total_sales_amount: string | null;
  notes: string | null;
  /** Contador de order_number de esta apertura — arranca en 0, cada pedido nuevo lo incrementa atómicamente. */
  next_order_number: Generated<number>;
}

export interface PromotionsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  promo_price: string;
  is_active: Generated<boolean>;
  starts_at: Timestamp | null;
  ends_at: Timestamp | null;
  sort_order: Generated<number>;
  image_url: string | null;
  archived_at: Timestamp | null;
  revision: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PromotionItemsTable {
  id: Generated<string>;
  promotion_id: string;
  product_id: string;
  quantity: number;
}

/** Componentes del combo congelados al momento de la venta, no un join en vivo con products. */
export interface OrderPromotionComponentSnapshot {
  productId: string;
  code: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

export interface OrderPromotionsTable {
  id: Generated<string>;
  order_id: string;
  promotion_id: string | null;
  promotion_name_snapshot: string;
  promo_price_snapshot: string;
  combo_quantity: number;
  subtotal: string;
  components_snapshot: JSONColumnType<OrderPromotionComponentSnapshot[]>;
  round_number: Generated<number>;
  added_at: Timestamp;
  voided_at: Timestamp | null;
  voided_by: string | null;
  void_reason: string | null;
}

export type ReservationStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'seated'
  | 'cancelled'
  | 'no_show'
  | 'expired';

export type ReservationDepositStatus =
  | 'none'
  | 'pending'
  | 'paid'
  | 'refund_due'
  | 'refunded'
  | 'forfeited'
  | 'applied';

export interface ReservationSettingsTable {
  id: true;
  enabled: Generated<boolean>;
  deposit_amount: Generated<string>;
  slot_minutes: Generated<number>;
  block_minutes: Generated<number>;
  hold_minutes: Generated<number>;
  payment_ttl_minutes: Generated<number>;
  cancel_refund_hours: Generated<number>;
  min_lead_minutes: Generated<number>;
  max_days_ahead: Generated<number>;
  max_occupancy_percent: Generated<number>;
  last_slot_before_close_minutes: Generated<number>;
  updated_at: Timestamp;
}

export interface ReservationsTable {
  id: Generated<string>;
  reservation_number: string;
  table_id: string;
  party_size: number;
  customer_name: string;
  customer_phone: string;
  notes: string | null;
  starts_at: Timestamp;
  blocks_until: Timestamp;
  expires_at: Timestamp;
  status: Generated<ReservationStatus>;
  deposit_amount: string;
  deposit_status: Generated<ReservationDepositStatus>;
  deposit_order_id: string | null;
  account_order_id: string | null;
  cancelled_at: Timestamp | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type TableShape = 'square' | 'round' | 'rectangle';

export interface FloorsTable {
  id: Generated<string>;
  name: string;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TablesTable {
  id: Generated<string>;
  floor_id: string;
  label: string;
  seats: Generated<number>;
  /** numeric(8,2) llega como string del driver pg. */
  x: Generated<string>;
  y: Generated<string>;
  width: Generated<string>;
  height: Generated<string>;
  rotation: Generated<string>;
  shape: Generated<TableShape>;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * business_opens_hour/business_closes_hour son ahora un margen ANCHO de
 * cordura, no el límite preciso de apertura/cierre (el horario real no es
 * fijo) — el gate de horario los usa solo para descartar de una un mensaje
 * claramente fuera de cualquier horario plausible. Adentro de ese margen,
 * la caja abierta/cerrada decide si el pedido pasa directo o se encola para
 * revisión humana. Ver checkoutGateAt en common/time/service-window.ts.
 */
export interface OperationalSettingsTable {
  id: true;
  rain_surcharge_enabled: Generated<boolean>;
  rain_surcharge_amount: Generated<string>;
  business_opens_hour: Generated<number>;
  business_closes_hour: Generated<number>;
  restaurant_latitude: number | null;
  restaurant_longitude: number | null;
  /** Tipos de servicio que el local toma. Solo afecta a pedidos nuevos. */
  service_delivery_enabled: Generated<boolean>;
  service_pickup_enabled: Generated<boolean>;
  service_dine_in_enabled: Generated<boolean>;
  /** Canales de origen que el local acepta (se derivan de la credencial, no del body). */
  channel_pos_enabled: Generated<boolean>;
  channel_whatsapp_enabled: Generated<boolean>;
  channel_web_enabled: Generated<boolean>;
  /** POS ajeno que reporta ventas ya cobradas (cocina y métricas). Arranca apagado. */
  channel_external_enabled: Generated<boolean>;
  /** Pedido mínimo por tipo de servicio, contra el subtotal (sin envío). 0 = sin mínimo. */
  min_order_delivery: Generated<string>;
  min_order_pickup: Generated<string>;
  min_order_dine_in: Generated<string>;
  /** 'bands' = por distancia (delivery_tariff_bands), 'fixed' = delivery_fixed_fee, 'free' = sin costo. */
  delivery_pricing_mode: Generated<'bands' | 'fixed' | 'free'>;
  delivery_fixed_fee: string | null;
  /** Si no es null, un pedido cuyo subtotal lo alcanza tiene envío gratis. */
  delivery_free_over_amount: string | null;
  /** Techo de reparto automático; más allá, cotización manual. null = el que dé la tarifa. */
  delivery_max_distance_meters: number | null;
  /** Si es false, cobrar no exige caja abierta y el gate de horario no depende de ella. */
  require_open_register: Generated<boolean>;
  /** Qué hacer con un pedido dentro del margen horario sin caja abierta: encolar, rechazar o aceptar. */
  out_of_hours_policy: Generated<'queue' | 'reject' | 'accept'>;
  /** Tope del monto que el staff puede fijar a mano en una cotización de delivery manual. */
  manual_quote_max_amount: Generated<string>;
  /** true: el efectivo de pickup/mesa exige estar pagado antes de `preparing` (el de delivery lo cobra el repartidor). */
  cash_prepayment_required: Generated<boolean>;
  /** Días en que el local abre: domingo = 0 … sábado = 6. */
  open_weekdays: Generated<number[]>;
  /** Último minuto del día (0–1439) en que se acepta un pedido de delivery / recojo; null = sin tope propio. */
  delivery_last_order_minute: number | null;
  pickup_last_order_minute: number | null;
  updated_at: Timestamp;
}

export type DashboardUserRole = 'admin' | 'cashier';

export interface DashboardUsersTable {
  id: Generated<string>;
  username: string;
  password_hash: string;
  role: DashboardUserRole;
  is_active: Generated<boolean>;
  created_at: Timestamp;
}

export type NotificationJobChannel = 'whatsapp' | 'telegram';
export type NotificationJobStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface NotificationJobsTable {
  id: Generated<string>;
  kind: string;
  channel: NotificationJobChannel;
  target_ref: string;
  payload: JSONColumnType<Record<string, unknown>>;
  status: Generated<NotificationJobStatus>;
  claim_token: string | null;
  claimed_until: Timestamp | null;
  attempts: Generated<number>;
  next_attempt_at: Timestamp | null;
  external_message_id: string | null;
  last_error_code: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Database {
  categories: CategoriesTable;
  products: ProductsTable;
  product_complements: ProductComplementsTable;
  customers: CustomersTable;
  idempotency_keys: IdempotencyKeysTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  late_order_requests: LateOrderRequestsTable;
  delivery_tariff_bands: DeliveryTariffBandsTable;
  delivery_quote_requests: DeliveryQuoteRequestsTable;
  payment_attempts: PaymentAttemptsTable;
  bank_qr_charges: BankQrChargesTable;
  promotions: PromotionsTable;
  promotion_items: PromotionItemsTable;
  order_promotions: OrderPromotionsTable;
  cash_register_sessions: CashRegisterSessionsTable;
  operational_settings: OperationalSettingsTable;
  payment_options: PaymentOptionsTable;
  order_day_counters: OrderDayCountersTable;
  dashboard_users: DashboardUsersTable;
  notification_jobs: NotificationJobsTable;
  floors: FloorsTable;
  tables: TablesTable;
  reservation_settings: ReservationSettingsTable;
  reservations: ReservationsTable;
}
