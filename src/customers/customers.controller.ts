import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { NotFoundDomainError, ValidationError } from '../common/exceptions/domain-exception';
import { CustomersService } from './customers.service';
import { FindOrCreateCustomerDto } from './dto/find-or-create-customer.dto';

@Controller('customers')
@UseGuards(ServiceOrStaffAuthGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post('find-or-create')
  findOrCreate(@Body() dto: FindOrCreateCustomerDto) {
    return this.customers.findOrCreate(dto);
  }

  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findById(id);
  }

  @Get()
  async findByPhone(@Query('phone') phone?: string) {
    if (!phone) {
      throw new ValidationError('El query param "phone" es requerido.');
    }
    const customer = await this.customers.findByPhone(phone);
    if (!customer) throw new NotFoundDomainError('customer', phone);
    return customer;
  }
}
