import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixedFailure = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

async function loadProductionInspector() {
  const result = await build({
    stdin: {
      contents: [
        'export { LocalCatalogTxtSourceAdapter } from "./src/adapters/local-catalog-txt-source-adapter.ts";',
        'export { CatalogTxtParser } from "./src/catalog/catalog-txt-parser.ts";',
        'export { CATALOG_TXT_IMPORT_BUDGET } from "./src/catalog/hybrid-catalog-types.ts";',
      ].join("\n"),
      loader: "ts",
      resolveDir: projectRoot,
      sourcefile: "catalog-txt-aggregate-runtime.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "silent",
  });
  if (result.outputFiles.length !== 1 || result.outputFiles[0]?.contents.byteLength === 0) {
    throw new Error("aggregate-runtime-unavailable");
  }
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    result.outputFiles[0].contents,
  ).toString("base64")}`;
  // The URL contains only the in-memory bundle produced above from fixed project entry points.
  // eslint-disable-next-line no-unsanitized/method -- Import only the fixed in-memory production bundle.
  return import(moduleUrl);
}

async function run(path) {
  const runtime = await loadProductionInspector();
  const source = await new runtime.LocalCatalogTxtSourceAdapter().open(path);
  const summary = await new runtime.CatalogTxtParser().parse({
    source,
    onCandidate: async () => undefined,
  });
  const aggregate = {
    source_sha256: summary.sourceSha256,
    byte_size: summary.byteSize,
    nonempty_lines: summary.nonEmptyLineCount,
    pdf_count: summary.pdfCount,
    directory_count: summary.directoryCount,
    ignored_leaf_count: summary.ignoredLeafCount,
    duplicate_pdf_paths: 0,
    max_depth: summary.maxDepth,
    within_70000_limit: summary.pdfCount <= runtime.CATALOG_TXT_IMPORT_BUDGET.maxPdfCount,
  };
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);
}

if (process.argv.length !== 3) {
  fixedFailure("catalog_txt_inspection_requires_one_path");
} else {
  try {
    await run(process.argv[2]);
  } catch {
    fixedFailure("catalog_txt_inspection_failed");
  }
}
