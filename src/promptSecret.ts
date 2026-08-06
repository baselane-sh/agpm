// Reads a secret from a raw-mode TTY without echoing the typed characters, so a
// pasted token never lands in the terminal scrollback. The structural stream
// interfaces exist so tests can drive the reader without a real terminal.
import { AgpmError } from "./errors.js";

export interface SecretInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  off(event: "data", cb: (chunk: Buffer) => void): unknown;
}

export interface SecretOutput {
  write(text: string): unknown;
}

const ENTER_CR = "\r";
const ENTER_LF = "\n";
const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";
const CTRL_H = "\b";

export function readSecretRaw(message: string, input: SecretInput, output: SecretOutput): Promise<string> {
  output.write(message);
  input.setRawMode?.(true);
  input.resume();
  let value = "";
  return new Promise<string>((resolve, reject) => {
    function finish(settle: () => void): void {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      settle();
    }
    function onData(chunk: Buffer): void {
      for (const char of chunk.toString("utf8")) {
        if (char === ENTER_CR || char === ENTER_LF) {
          finish(() => resolve(value));
          return;
        }
        if (char === CTRL_C) {
          finish(() => reject(new AgpmError("login cancelled")));
          return;
        }
        if (char === BACKSPACE || char === CTRL_H) {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    }
    input.on("data", onData);
  });
}
