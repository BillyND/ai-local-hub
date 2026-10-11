import { readFile } from "node:fs/promises";

/** Version from the package.json next to the compiled (or source) entry directory. */
export async function readPackageVersion(): Promise<string> {
  const packageJson: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    !packageJson ||
    typeof packageJson !== "object" ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string"
  )
    throw new Error("package.json is missing its version.");
  return packageJson.version;
}
