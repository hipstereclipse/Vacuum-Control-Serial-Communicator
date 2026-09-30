import { access, cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const output = path.resolve("dist", "client");
const [githubOwner = "", githubRepositoryName = ""] = (
  process.env.GITHUB_REPOSITORY ?? ""
).split("/");
const hasProjectPrefix =
  githubRepositoryName &&
  githubRepositoryName.toLowerCase() !== `${githubOwner.toLowerCase()}.github.io`;

await access(path.join(output, "index.html"));

if (hasProjectPrefix) {
  const prefixedOutput = path.resolve(output, githubRepositoryName);
  const prefixedAssets = path.join(prefixedOutput, "_next");
  const publishedAssets = path.join(output, "_next");

  if (!prefixedOutput.startsWith(`${output}${path.sep}`)) {
    throw new Error("Refusing to package assets outside dist/client.");
  }

  await access(prefixedAssets);
  await rm(publishedAssets, { recursive: true, force: true });
  await cp(prefixedAssets, publishedAssets, { recursive: true });
  await rm(prefixedOutput, { recursive: true, force: true });
}

await writeFile(path.join(output, ".nojekyll"), "", "utf8");

const html = await readFile(path.join(output, "index.html"), "utf8");
const assetUrls = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((url) => url.startsWith("./") || url.startsWith("/"));
const projectPrefix = hasProjectPrefix ? `/${githubRepositoryName}/` : "/";

await Promise.all(
  assetUrls.map(async (url) => {
    const relativeAsset = url.startsWith("./")
      ? url.slice(2)
      : url.startsWith(projectPrefix)
        ? url.slice(projectPrefix.length)
        : null;

    // URLs may include a cache-busting query string; the emitted file does not.
    if (relativeAsset) await access(path.join(output, relativeAsset.split(/[?#]/, 1)[0]));
  })
);

console.log("GitHub Pages package prepared in dist/client/.");
