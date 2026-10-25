export function resetChangedAdminEmail(current: string | null, next: string | undefined) {
  return next !== undefined && next !== current
    ? { emailVerifiedAt: null, emailVerificationTokenHash: null, emailVerificationExpiresAt: null }
    : {};
}
