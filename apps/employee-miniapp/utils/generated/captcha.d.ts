export interface SmsChallenge {
    required: boolean;
    challenge?: {
        c: number;
        s: number;
        d: number;
    };
    token?: string;
    expires?: number;
}
export interface CaptchaProof {
    token: string;
    solutions: number[];
}
/** Cap 3 format-1 SHA-256 PoW. No DOM, eval, CDN, WebCrypto or Node APIs required. */
export declare function solveSmsChallenge(input: SmsChallenge, onProgress?: (percent: number) => void, cancelled?: () => boolean): Promise<CaptchaProof | undefined>;
export declare function retrySeconds(error: unknown): number;
