import { Body, Controller, ForbiddenException, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiClient } from '../common/decorators/api-client.decorator';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { AgentLocationsService } from './agent-locations.service';
import { AttachAgentLocationDto } from './dto/attach-agent-location.dto';

/** Canal del agente de WhatsApp: se reutiliza el api_client existente, no hay canal nuevo. */
const AGENT_API_CLIENT = 'whatsapp-gateway';

@Controller('internal/agent')
@UseGuards(ServiceAuthGuard)
export class AgentLocationsController {
  constructor(private readonly locations: AgentLocationsService) {}

  // Todos los resultados (incluido no_order / location_conflict) son 200 con
  // `result`: son desenlaces esperados del flujo, no errores HTTP.
  @Post('locations/attach')
  @HttpCode(200)
  attach(@Body() dto: AttachAgentLocationDto, @ApiClient() apiClient: string) {
    if (apiClient !== AGENT_API_CLIENT) {
      throw new ForbiddenException('Este endpoint es solo para el canal whatsapp-gateway.');
    }
    return this.locations.attach(dto, apiClient);
  }
}
