#!/usr/bin/env node
import { runCli } from "./cli.js";

try {
  const code = await runCli(process.argv.slice(2), process.cwd(), (line) => {
    process.stdout.write(line + "\n");
  });
  process.exit(code);
} catch (error) {
  process.stderr.write(`agpm: internal error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
