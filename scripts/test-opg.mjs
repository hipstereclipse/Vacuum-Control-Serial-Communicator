import { runSuites } from "./run-tests.mjs";

await runSuites(["opg"]);
process.exit(process.exitCode ?? 0);
