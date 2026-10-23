import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { SetAvailabilityDto } from './dto/set-availability.dto';
import { UploadProductImageDto } from './dto/upload-product-image.dto';
import { ReplaceProductOptionGroupsDto } from './dto/product-option-groups.dto';

import { ApiOkResponse, ApiProduces } from '@nestjs/swagger';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @UseGuards(ServiceOrStaffAuthGuard)
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  findMany(@Query('includeInactive') includeInactive?: string) {
    return this.products.findMany(includeInactive === 'true');
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  // Reemplaza los grupos de opciones y sus opciones (carnes de una tabla, tamaño...) conservando los ids por `code`.
  @Put(':id/option-groups')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  replaceOptionGroups(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceProductOptionGroupsDto) {
    return this.products.replaceOptionGroups(id, dto);
  }

  // «Se acabó esta carne»: como el agotado de un producto, también es decisión de piso de cocina.
  @Patch('options/:optionId/availability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  setOptionAvailability(@Param('optionId', ParseUUIDPipe) optionId: string, @Body() dto: SetAvailabilityDto) {
    return this.products.setOptionAvailability(optionId, dto.available);
  }

  // Marcar agotado/disponible es una decisión de piso de cocina, no solo de admin.
  @Patch(':id/availability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  setAvailability(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetAvailabilityDto) {
    return this.products.setAvailability(id, dto.available);
  }

  @Post(':id/image')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  uploadImage(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UploadProductImageDto) {
    return this.products.uploadImage(id, dto);
  }

  /** Streaming autenticado — nunca una URL directa al bucket. */
  @Get(':id/image')
  @UseGuards(ServiceOrStaffAuthGuard)
  @ApiProduces('image/png', 'image/jpeg', 'image/webp')
  @ApiOkResponse({
    description: 'La imagen.',
    content: { 'image/*': { schema: { type: 'string', format: 'binary' } } },
  })
  async getImage(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { bytes, mimeType } = await this.products.getImage(id);
    res.setHeader('content-type', mimeType);
    res.setHeader('cache-control', 'private, max-age=3600');
    res.send(bytes);
  }
}
