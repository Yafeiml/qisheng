export interface PutObjectRequest {
  bytes: Uint8Array;
  checksum: string;
  key: string;
  mimeType: string;
}

export interface SignedPutObjectRequest {
  byteSize: number;
  key: string;
  mimeType: string;
}

export interface StoredObjectMetadata {
  byteSize: number;
  checksum?: string;
  contentType?: string;
  etag?: string;
  key: string;
}

export interface StoredObject {
  byteSize: number;
  checksum: string;
  etag: string;
  key: string;
}

export interface ObjectStorage {
  delete(key: string): Promise<void>;
  get(key: string, maxBytes?: number): Promise<Uint8Array>;
  head(key: string): Promise<StoredObjectMetadata>;
  put(request: PutObjectRequest): Promise<StoredObject>;
  signedGetUrl(key: string, expiresInSeconds?: number): Promise<string>;
  signedPutUrl(request: SignedPutObjectRequest, expiresInSeconds?: number): Promise<string>;
}

export interface GeneratedImageObjectKeyInput {
  campaignId: string;
  checksum: string;
  employeeContentId: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sequence: number;
  tenantId: string;
}

export interface MaterialArtifactObjectKeyInput {
  artifactId: string;
  fileName: string;
  materialId: string;
  tenantId: string;
}
