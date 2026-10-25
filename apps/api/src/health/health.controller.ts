import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { HealthService } from "./health.service";
import { LivenessResponseDto, ReadinessResponseDto } from "./health-response.dto";

@Controller("health")
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get("live")
  @ApiOkResponse({ type: LivenessResponseDto })
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOkResponse({ type: ReadinessResponseDto })
  async ready(): Promise<unknown> {
    const result = await this.healthService.checkDependencies();
    if (result.status !== "ok") {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
