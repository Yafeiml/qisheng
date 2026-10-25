import { ProviderInvocationError } from "./errors";
import type {
  ImageGenerationOutput,
  ImageGenerationProvider,
  ImageGenerationRequest,
  TextGenerationOutput,
  TextGenerationProvider,
  TextGenerationRequest,
} from "./types";

export interface SyntheticProviderOptions {
  estimatedCost: number;
  failFirstCalls?: number;
  providerId: string;
}

abstract class SyntheticProviderBase {
  readonly providerId: string;
  protected readonly estimatedCost: number;
  private calls = 0;

  constructor(options: SyntheticProviderOptions) {
    this.providerId = options.providerId;
    this.estimatedCost = options.estimatedCost;
    this.remainingFailures = options.failFirstCalls ?? 0;
  }

  private remainingFailures: number;

  protected beforeGenerate(): number {
    this.calls += 1;
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new ProviderInvocationError("Synthetic retryable failure", "SYNTHETIC_RETRYABLE", true);
    }
    return this.calls;
  }
}

export class SyntheticTextProvider extends SyntheticProviderBase implements TextGenerationProvider {
  async generate(modelId: string, request: TextGenerationRequest): Promise<TextGenerationOutput> {
    const call = this.beforeGenerate();
    return {
      finishReason: "synthetic",
      providerRequestId: `${this.providerId}-text-${call}`,
      text: `[SYNTHETIC:${modelId}] ${request.prompt.slice(0, 48)}`,
      usage: {
        estimatedCost: this.estimatedCost,
        inputUnits: request.prompt.length,
        outputUnits: 64,
      },
    };
  }
}

export class SyntheticImageProvider
  extends SyntheticProviderBase
  implements ImageGenerationProvider
{
  async generate(modelId: string, request: ImageGenerationRequest): Promise<ImageGenerationOutput> {
    const call = this.beforeGenerate();
    const hue = Number.parseInt(request.seed.slice(-3), 16) % 360 || 168;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${request.width}" height="${request.height}"><!-- uniqueness-seed:${request.seed} --><defs><linearGradient id="g"><stop stop-color="hsl(${hue} 58% 24%)"/><stop offset="1" stop-color="hsl(${(hue + 74) % 360} 52% 62%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="72%" cy="22%" r="18%" fill="white" opacity=".16"/><text x="8%" y="76%" fill="white" font-size="48">SYNTHETIC ${modelId}</text></svg>`;

    return {
      bytes: new TextEncoder().encode(svg),
      height: request.height,
      mimeType: "image/svg+xml",
      providerRequestId: `${this.providerId}-image-${call}`,
      usage: { estimatedCost: this.estimatedCost },
      width: request.width,
    };
  }
}
