export class AgpmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgpmError";
  }
}
