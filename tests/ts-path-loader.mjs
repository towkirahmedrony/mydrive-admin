/**
 * Node ESM resolve hook for the `node --test` runner.
 *
 * The test files are TypeScript and import source modules the same way the app
 * does:
 *   - `@/lib/...`  (the tsconfig path alias)
 *   - `../src/lib/<module>`  (extensionless, Next.js/TS style)
 *
 * Neither resolves in plain Node ESM, which requires a real file URL. This hook
 * maps the alias onto `src/` and appends `.ts`/`.tsx` when a matching file
 * exists, so the existing tests can be executed unchanged with:
 *
 *   node --experimental-strip-types --import ./tests/register.mjs --test tests/*.test.ts
 *
 * It only affects the test runner; nothing in `src/` imports it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withExtension(absPath) {
  if (existsSync(absPath) && path.extname(absPath)) return absPath;
  for (const ext of [".ts", ".tsx", ".mts", ".js"]) {
    if (existsSync(absPath + ext)) return absPath + ext;
  }
  for (const ext of [".ts", ".tsx"]) {
    const indexPath = path.join(absPath, `index${ext}`);
    if (existsSync(indexPath)) return indexPath;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const resolved = withExtension(path.join(root, "src", specifier.slice(2)));
    if (resolved) return nextResolve(pathToFileURL(resolved).href, context);
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (context.parentURL?.startsWith("file:")) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const resolved = withExtension(path.resolve(parentDir, specifier));
      if (resolved) return nextResolve(pathToFileURL(resolved).href, context);
    }
  }

  // Bare package subpaths that Next resolves through its bundler (for example
  // `next/link`) are extensionless in source; Node needs the real file.
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const bare =
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.includes(":");
    if (bare) {
      for (const suffix of [".js", ".jsx", ".mjs", ".cjs"]) {
        try {
          return await nextResolve(specifier + suffix, context);
        } catch {
          // try the next extension
        }
      }
    }
    throw error;
  }
}

/**
 * Transpiles `.ts` / `.tsx` (including JSX) with the project's own TypeScript
 * compiler. Type stripping alone cannot handle JSX, which is what the component
 * render tests need.
 */
export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && /\.tsx?$/.test(url)) {
    const fileName = fileURLToPath(url);
    const source = readFileSync(fileName, "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
        sourceMap: false,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }

  return nextLoad(url, context);
}
