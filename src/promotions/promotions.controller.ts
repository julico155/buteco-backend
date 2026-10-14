import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PromotionsService } from './promotions.service';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { SetActiveDto, SetArchivedDto } from './dto/set-flag.dto';
import { MovePromotionDto } from './dto/move-promotion.dto';

@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @UseGuards(ServiceOrStaffAuthGuard)
  findAll() {
    return this.promotions.findAll();
  }

  @Get(':id')
  @UseGuards(ServiceOrStaffAuthGuard)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreatePromotionDto) {
    return this.promotions.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotions.update(id, dto);
  }

  @Patch(':id/active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetActiveDto) {
    return this.promotions.setActive(id, dto.active);
  }

  @Patch(':id/archived')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  setArchived(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetArchivedDto) {
    return this.promotions.setArchived(id, dto.archived);
  }

  @Post(':id/duplicate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  duplicate(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.duplicate(id);
  }

  @Post(':id/move')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MovePromotionDto) {
    return this.promotions.move(id, dto.sortOrder);
  }
}
