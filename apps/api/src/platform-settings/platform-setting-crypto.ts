import { Injectable } from "@nestjs/common";
import { ModelCredentialCipher, modelCredentialLastFour } from "@xhs-agentic/ai-gateway";

export type StoredPlatformSettingSecret = Readonly<{
  authenticationTag: Uint8Array;
  ciphertext: Uint8Array;
  initializationVector: Uint8Array;
  key: string;
  keyVersion: string;
}>;

@Injectable()
export class PlatformSettingCrypto {
  private cipherInstance?: ModelCredentialCipher;

  encrypt(value: string, key: string) {
    return {
      ...this.cipher().encrypt(value, associatedData(key)),
      secretLastFour: modelCredentialLastFour(value),
    };
  }

  decrypt(setting: StoredPlatformSettingSecret): string {
    return this.cipher().decrypt(setting, associatedData(setting.key));
  }

  private cipher(): ModelCredentialCipher {
    this.cipherInstance ??= ModelCredentialCipher.fromEnvironment();
    return this.cipherInstance;
  }
}

export function platformSettingAssociatedData(key: string): string {
  return associatedData(key);
}

function associatedData(key: string): string {
  return `xhs-agentic:platform-setting:${key}`;
}
