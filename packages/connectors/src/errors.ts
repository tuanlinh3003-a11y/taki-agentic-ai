export class ConnectorError extends Error {
  constructor(public kind: "AuthError" | "RateLimited" | "Transient" | "InvalidRequest" | "PolicyRejected" | "NotFound", message: string) {
    super(message);
  }
}
