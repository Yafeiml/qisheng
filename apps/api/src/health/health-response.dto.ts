export class LivenessResponseDto {
  status!: "ok";
}

export class DependencyCheckDto {
  latencyMs!: number;
  status!: "error" | "ok";
}

export class ReadinessChecksDto {
  database!: DependencyCheckDto;
  generationQueue!: DependencyCheckDto;
  objectStorage!: DependencyCheckDto;
  redis!: DependencyCheckDto;
}

export class ReadinessResponseDto {
  checks!: ReadinessChecksDto;
  status!: "error" | "ok";
}
