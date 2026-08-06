import { describe, expect, it } from "vitest";
import { AgpmError } from "../src/errors.js";
import { readSecretRaw } from "../src/promptSecret.js";
import type { SecretInput, SecretOutput } from "../src/promptSecret.js";

interface FakeStreams {
  input: SecretInput;
  output: SecretOutput;
  written: string[];
  rawModeCalls: boolean[];
  feed(text: string): void;
  paused(): boolean;
}

function makeFakeStreams(): FakeStreams {
  const written: string[] = [];
  const rawModeCalls: boolean[] = [];
  let listener: ((chunk: Buffer) => void) | undefined;
  let isPaused = true;
  const input: SecretInput = {
    isTTY: true,
    setRawMode(mode: boolean) {
      rawModeCalls.push(mode);
    },
    resume() {
      isPaused = false;
    },
    pause() {
      isPaused = true;
    },
    on(event: "data", cb: (chunk: Buffer) => void) {
      if (event === "data") listener = cb;
    },
    off(event: "data", cb: (chunk: Buffer) => void) {
      if (event === "data" && listener === cb) listener = undefined;
    },
  };
  const output: SecretOutput = {
    write(text: string) {
      written.push(text);
    },
  };
  return {
    input,
    output,
    written,
    rawModeCalls,
    feed(text: string) {
      if (listener === undefined) throw new Error("promptSecret.test.ts: no data listener attached");
      listener(Buffer.from(text, "utf8"));
    },
    paused: () => isPaused,
  };
}

describe("readSecretRaw", () => {
  it("resolves the typed value on enter without echoing any character", async () => {
    const fake = makeFakeStreams();
    const promise = readSecretRaw("paste a token: ", fake.input, fake.output);
    fake.feed("tok_secret123");
    fake.feed("\r");
    const value = await promise;
    expect(value).toBe("tok_secret123");
    const allOutput = fake.written.join("");
    expect(allOutput).toContain("paste a token: ");
    expect(allOutput).not.toContain("tok_secret123");
    expect(allOutput).not.toContain("t o k");
    expect(allOutput.endsWith("\n")).toBe(true);
  });

  it("never writes any typed character to the output", async () => {
    const fake = makeFakeStreams();
    const promise = readSecretRaw("prompt: ", fake.input, fake.output);
    const before = fake.written.length;
    fake.feed("abc");
    expect(fake.written.length).toBe(before);
    fake.feed("\n");
    await promise;
  });

  it("handles backspace by dropping the last character", async () => {
    const fake = makeFakeStreams();
    const promise = readSecretRaw("prompt: ", fake.input, fake.output);
    fake.feed("abcd");
    fake.feed("\u007f");
    fake.feed("\r");
    expect(await promise).toBe("abc");
  });

  it("restores the terminal on resolve: raw mode off, input paused", async () => {
    const fake = makeFakeStreams();
    const promise = readSecretRaw("prompt: ", fake.input, fake.output);
    fake.feed("x\r");
    await promise;
    expect(fake.rawModeCalls).toEqual([true, false]);
    expect(fake.paused()).toBe(true);
  });

  it("rejects with AgpmError on ctrl-c and restores the terminal", async () => {
    const fake = makeFakeStreams();
    const promise = readSecretRaw("prompt: ", fake.input, fake.output);
    fake.feed("ab\u0003");
    await expect(promise).rejects.toThrow(new AgpmError("login cancelled"));
    expect(fake.rawModeCalls).toEqual([true, false]);
    expect(fake.paused()).toBe(true);
  });

  it("accumulates across multiple chunks", async () => {
    const fake = makeFakeStreams();
    const promise = readSecretRaw("prompt: ", fake.input, fake.output);
    fake.feed("tok_");
    fake.feed("part");
    fake.feed("\r");
    expect(await promise).toBe("tok_part");
  });
});
