import { ApiProperty } from '@nestjs/swagger';
import { OrderQuoteResponse } from '../../delivery/dto/delivery-response.dto';

/**
 * Respuestas de `POST /internal/agent/locations/attach`. Todos los desenlaces son
 * 200 con `result` (no hay pedido, es ambiguo, ya estaba, etc.): se discriminan
 * por ese campo.
 */

export class AgentLocationOrderSummary {
  id!: string;
  orderNumber!: string;
  totalAmount!: number;
}

export class AgentLocationNoOrder {
  @ApiProperty({ enum: ['no_order'] })
  result!: 'no_order';
}

export class AgentLocationAmbiguousOrder {
  @ApiProperty({ enum: ['ambiguous_order'] })
  result!: 'ambiguous_order';
  orders!: AgentLocationOrderSummary[];
}

export class AgentLocationConflict {
  @ApiProperty({ enum: ['location_conflict'] })
  result!: 'location_conflict';
  orders!: AgentLocationOrderSummary[];
}

export class AgentLocationAlreadyAttached {
  @ApiProperty({ enum: ['already_attached'] })
  result!: 'already_attached';
  orderId!: string;
  orderNumber!: string;
}

export class AgentLocationAttached {
  @ApiProperty({ enum: ['attached'] })
  result!: 'attached';
  orderId!: string;
  orderNumber!: string;
  quote!: OrderQuoteResponse;
}

export type AgentLocationResponse =
  | AgentLocationNoOrder
  | AgentLocationAmbiguousOrder
  | AgentLocationConflict
  | AgentLocationAlreadyAttached
  | AgentLocationAttached;
