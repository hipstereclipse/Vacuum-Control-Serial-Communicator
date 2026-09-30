import { runSuites } from "./run-tests.mjs";

await runSuites(["framers"]);
process.exit(process.exitCode ?? 0);
