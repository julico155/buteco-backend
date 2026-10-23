export class ProductComplementResponse {
  id!: string;
  name!: string;
  sortOrder!: number;
}

export class ProductOptionResponse {
  id!: string;
  /** Contrato con el menú (qué recorte dibujar); estable entre ediciones. */
  code!: string;
  name!: string;
  /** Se suma al precio base del producto. */
  priceDelta!: number;
  isAvailable!: boolean;
  sortOrder!: number;
}

export class ProductOptionGroupResponse {
  id!: string;
  code!: string;
  name!: string;
  minSelect!: number;
  maxSelect!: number;
  sortOrder!: number;
  /** El aviso de delivery nombra lo elegido en este grupo (p. ej. «Tamaño»). */
  showInNotice!: boolean;
  options!: ProductOptionResponse[];
}

export class ProductResponse {
  id!: string;
  code!: string;
  name!: string;
  description!: string | null;
  categoryId!: string;
  price!: number;
  isActive!: boolean;
  isAvailable!: boolean;
  sortOrder!: number;
  imageUrl!: string | null;
  complements!: ProductComplementResponse[];
  optionGroups!: ProductOptionGroupResponse[];
  /** Días en que se vende (domingo = 0 … sábado = 6, hora de La Paz); null = todos. */
  availableWeekdays!: number[] | null;
  /** Solo la regla de días, calculada para hoy. Se vende hoy si `isAvailable && isAvailableToday`. */
  isAvailableToday!: boolean;
  servesLabel!: string | null;
  prepMinutes!: number | null;
}
