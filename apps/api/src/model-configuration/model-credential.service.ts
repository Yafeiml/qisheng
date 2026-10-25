import { Injectable } from "@nestjs/common";
import {
  ModelCredentialCipher,
  modelCredentialAssociatedData,
  modelCredentialLastFour,
} from "@xhs-agentic/ai-gateway";

export type StoredModelCredential = Readonly<{
  authenticationTag: Uint8Array;
  ciphertext: Uint8Array;
  id: string;
  initializationVector: Uint8Array;
  keyVersion: string;
  providerId: string;
}>;

@Injectable()
export class ModelCredentialService {
  private cipherInstance?: ModelCredentialCipher;

  encrypt(apiKey: string, providerId: string, credentialId: string) {
    const encrypted = this.cipher().encrypt(
      apiKey,
      modelCredentialAssociatedData(providerId, credentialId),
    );
    return {
      ...encrypted,
      lastFour: modelCredentialLastFour(apiKey),
    };
  }

  decrypt(credential: StoredModelCredential): string {
    return this.cipher().decrypt(
      credential,
      modelCredentialAssociatedData(credential.providerId, credential.id),
    );
  }

  private cipher(): ModelCredentialCipher {
    this.cipherInstance ??= ModelCredentialCipher.fromEnvironment();
    return this.cipherInstance;
  }
}
