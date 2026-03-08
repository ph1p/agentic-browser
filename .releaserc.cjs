module.exports = {
  branches: ["main"],
  releaseRules: [
    { breaking: true, release: "major" },
    { type: "feat", release: "minor" },
    { type: "fix", release: "patch" },
    { type: "perf", release: "patch" },
    { type: "revert", release: "patch" },
  ],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { provenance: true }],
    "@semantic-release/github",
  ],
};
