export interface CredentialResolver {
  resolve(reference: string): Promise<string>;
}

export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: string): Promise<string> {
    const match = /^env:\/\/([A-Z][A-Z0-9_]*)$/u.exec(reference);
    if (!match) {
      const scheme = reference.split(":", 1)[0] ?? "unknown";
      throw new Error(`Credential reference scheme is not available in this runtime: ${scheme}`);
    }
    const name = match[1];
    if (!name) throw new Error("Credential environment variable name is missing");
    const value = this.environment[name];
    if (!value?.trim())
      throw new Error(`Credential environment variable is not configured: ${name}`);
    return value;
  }
}
