import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { EmployeeAccessGuard } from "../access/employee-access.guard";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: Nest requires request DTO classes at runtime.
import {
  EmployeeNotificationConfigurationDto,
  LinkEmployeeWechatIdentityDto,
  RecordEmployeeSubscriptionDto,
} from "./employee-notifications.dto";
import { EmployeeNotificationsService } from "./employee-notifications.service";

@ApiTags("Employee Notifications")
@Controller("employee/notifications")
@UseGuards(EmployeeAccessGuard)
export class EmployeeNotificationsController {
  constructor(
    @Inject(EmployeeNotificationsService)
    private readonly notifications: EmployeeNotificationsService,
  ) {}

  @Get("configuration")
  @ApiOkResponse({ type: EmployeeNotificationConfigurationDto })
  configuration() {
    return this.notifications.configuration();
  }

  @Post("identity")
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOkResponse({ type: EmployeeNotificationConfigurationDto })
  identity(@Body() input: LinkEmployeeWechatIdentityDto) {
    return this.notifications.linkIdentity(input);
  }

  @Post("subscriptions")
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOkResponse({ type: EmployeeNotificationConfigurationDto })
  subscriptions(
    @Body() input: RecordEmployeeSubscriptionDto,
    @Headers("idempotency-key") key: string,
  ) {
    return this.notifications.recordSubscription(input, key);
  }
}
