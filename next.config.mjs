/** @type {import('next').NextConfig} */
const githubRepository = process.env.GITHUB_REPOSITORY ?? "";
const [githubOwner = "", githubRepositoryName = ""] = githubRepository.split("/");
const isGitHubPagesBuild = process.env.GITHUB_PAGES === "true";
const isUserOrOrganizationSite =
  githubRepositoryName.toLowerCase() === `${githubOwner.toLowerCase()}.github.io`;
const githubPagesAssetPrefix =
  isGitHubPagesBuild && githubRepositoryName && !isUserOrOrganizationSite
    ? `/${githubRepositoryName}`
    : "";

const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  ...(isGitHubPagesBuild
    ? {
        output: "export",
        assetPrefix: githubPagesAssetPrefix,
        trailingSlash: true
      }
    : {})
};

export default nextConfig;
