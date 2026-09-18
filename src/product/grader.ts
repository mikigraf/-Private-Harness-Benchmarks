import { build } from "esbuild";
import { sha256 } from "../core/integrity.js";
export async function graderBundle(): Promise<{
  verifierModuleBase64: string;
  verifierSha256: string;
}> {
  const compiled = await build({
    entryPoints: ["src/benchmark/grader-entry.ts"],
    bundle: true,
    write: false,
    platform: "node",
    target: "node24",
    format: "esm",
    logLevel: "silent",
  });
  const text = compiled.outputFiles[0]?.contents;
  if (!text) throw new Error("Verifier build produced no output");
  return {
    verifierModuleBase64: Buffer.from(text).toString("base64"),
    verifierSha256: sha256(text),
  };
}
