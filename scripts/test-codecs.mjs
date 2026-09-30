import { runSuites } from "./run-tests.mjs";

await runSuites(["codecs"]);
process.exit(process.exitCode ?? 0);
