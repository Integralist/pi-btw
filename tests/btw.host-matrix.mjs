// Offline checks against the installed SDK, or an explicitly supplied host checkout.
// PI_BTW_SDK_ROOT is test configuration only; it is not a plugin dependency.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { startVitest } from "vitest/node";

process.env.PI_OFFLINE = "1";
process.env.JITI_FS_CACHE = "false";
const root = process.env.PI_BTW_SDK_ROOT;
const packages = ["pi-coding-agent", "pi-ai", "pi-tui", "pi-agent-core"];
const alias = root ? Object.fromEntries(packages.map((name) => [
  `@earendil-works/${name}`,
  path.join(path.resolve(root), "node_modules/@earendil-works", name, "dist/index.js"),
])) : {};
const vitest = await startVitest("test", [], {
  config: false, run: true, cache: false, environment: "node",
  include: ["tests/**/*.test.ts"], testTimeout: 15000,
}, { resolve: { alias }, cacheDir: path.resolve(".btw-test-cache") });
const testsFailed = vitest.state.getFiles().some((file) => file.result?.state === "fail");
await vitest.close();

const config = ts.readConfigFile(path.resolve("tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
if (root) parsed.options.paths = Object.fromEntries(packages.flatMap((name) => [
  [`@earendil-works/${name}`, [path.join(path.resolve(root), "node_modules/@earendil-works", name, "dist/index.d.ts")]],
  [`@earendil-works/${name}/*`, [path.join(path.resolve(root), "node_modules/@earendil-works", name, "dist/*")]],
]));
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, incremental: false });
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: (f) => f, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => "\n",
}));

const sdkUrl = root ? pathToFileURL(alias["@earendil-works/pi-coding-agent"]).href : import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(sdkUrl);
const agentDir = path.resolve(".btw-test-cache/empty-agent");
fs.mkdirSync(agentDir, { recursive: true });
const loaded = await sdk.discoverAndLoadExtensions([path.resolve("extensions/btw.ts")], process.cwd(), agentDir);
const loadFailed = loaded.errors.length > 0 || loaded.extensions.length !== 1 || !loaded.extensions[0]?.commands.has("btw");
console.log(JSON.stringify({ sdk: sdkUrl, typeDiagnostics: diagnostics.length, loadedExtensions: loaded.extensions.length, loadErrors: loaded.errors }, null, 2));
process.exitCode = testsFailed || diagnostics.length || loadFailed ? 1 : 0;
