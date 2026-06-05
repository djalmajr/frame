#!/usr/bin/env bun

import { join } from "node:path";
import { spawn } from "bun";

const PACKAGES = {
  frame: "packages/frame",
  "frame-angular": "packages/frame-angular",
  "frame-react": "packages/frame-react",
  "frame-vue": "packages/frame-vue",
};

type PackageName = keyof typeof PACKAGES;
type VersionType = "major" | "minor" | "patch" | "prerelease";

interface PublishOptions {
  packages: PackageName[];
  dryRun: boolean;
  skipBuild: boolean;
  tag?: string;
  otp?: string;
  version?: VersionType;
  preid?: string;
}

function printHelp() {
  console.log(`
Usage: bun scripts/publish.ts [packages...] [options]

Packages:
  frame           @zomme/frame (core)
  frame-angular   @zomme/frame-angular
  frame-react     @zomme/frame-react
  frame-vue       @zomme/frame-vue
  (none)          All packages (default)

Options:
  --dry-run              Show what would be published without publishing
  --skip-build           Skip the build step
  --tag <tag>            Publish with a specific tag (e.g., beta, next)
  --otp <code>           OTP code for npm 2FA authentication
  --version <type>       Bump version before publish (major|minor|patch|prerelease)
  --preid <id>           Prerelease identifier (e.g., beta, alpha, rc)
  --help                 Show this help message

Examples:
  bun scripts/publish.ts                           # Publish all packages
  bun scripts/publish.ts frame --otp 123456        # Publish with OTP
  bun scripts/publish.ts --version=patch           # Bump patch & publish all
  bun scripts/publish.ts frame --version=prerelease --preid=beta --tag=beta
`);
}

function parseArgs(): PublishOptions | null {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    printHelp();
    return null;
  }

  const packages: PackageName[] = [];
  let dryRun = false;
  let skipBuild = false;
  let tag: string | undefined;
  let otp: string | undefined;
  let version: VersionType | undefined;
  let preid: string | undefined;

  const validVersions = ["major", "minor", "patch", "prerelease"];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-build") {
      skipBuild = true;
    } else if (arg === "--tag") {
      tag = args[++i];
    } else if (arg.startsWith("--tag=")) {
      tag = arg.split("=")[1];
    } else if (arg === "--otp") {
      otp = args[++i];
    } else if (arg.startsWith("--otp=")) {
      otp = arg.split("=")[1];
    } else if (arg === "--version") {
      const v = args[++i];
      if (!validVersions.includes(v)) {
        console.error(`Invalid version type: ${v}`);
        console.error(`Valid types: ${validVersions.join(", ")}`);
        process.exit(1);
      }
      version = v as VersionType;
    } else if (arg.startsWith("--version=")) {
      const v = arg.split("=")[1];
      if (!validVersions.includes(v)) {
        console.error(`Invalid version type: ${v}`);
        console.error(`Valid types: ${validVersions.join(", ")}`);
        process.exit(1);
      }
      version = v as VersionType;
    } else if (arg === "--preid") {
      preid = args[++i];
    } else if (arg.startsWith("--preid=")) {
      preid = arg.split("=")[1];
    } else if (arg === "all") {
      packages.push(...(Object.keys(PACKAGES) as PackageName[]));
    } else if (arg in PACKAGES) {
      packages.push(arg as PackageName);
    } else if (!arg.startsWith("--")) {
      console.error(`Unknown package: ${arg}`);
      console.error(`Available: ${Object.keys(PACKAGES).join(", ")}`);
      process.exit(1);
    }
  }

  // Default to all packages if none specified
  if (packages.length === 0) {
    packages.push(...(Object.keys(PACKAGES) as PackageName[]));
  }

  // Remove duplicates
  const uniquePackages = [...new Set(packages)];

  return { packages: uniquePackages, dryRun, skipBuild, tag, otp, version, preid };
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[],
  silent = false,
): Promise<{ success: boolean; output: string }> {
  const fullPath = join(process.cwd(), cwd);

  const proc = spawn([command, ...args], {
    cwd: fullPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let output = "";

  if (proc.stdout) {
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk);
      output += text;
      if (!silent) process.stdout.write(text);
    }
  }

  if (proc.stderr) {
    for await (const chunk of proc.stderr) {
      const text = decoder.decode(chunk);
      output += text;
      if (!silent) process.stderr.write(text);
    }
  }

  const exitCode = await proc.exited;
  return { success: exitCode === 0, output };
}

async function checkNpmAuth(): Promise<boolean> {
  console.log("Checking npm authentication...\n");

  const proc = spawn(["npm", "whoami"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("Not logged in to npm. Please run: npm login\n");
    return false;
  }

  const decoder = new TextDecoder();
  let username = "";
  if (proc.stdout) {
    for await (const chunk of proc.stdout) {
      username += decoder.decode(chunk);
    }
  }

  console.log(`Logged in as: ${username.trim()}\n`);
  return true;
}

async function getPackageInfo(pkgPath: string): Promise<{ name: string; version: string }> {
  const pkgJsonPath = join(process.cwd(), pkgPath, "package.json");
  const pkgJson = await Bun.file(pkgJsonPath).json();
  return { name: pkgJson.name, version: pkgJson.version };
}

/**
 * Calculate the next version based on semver rules
 */
function calculateNextVersion(
  currentVersion: string,
  versionType: VersionType,
  preid?: string,
): string {
  // Parse current version (e.g., "1.2.3" or "1.2.3-beta.0")
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)\.(\d+))?$/);

  if (!match) {
    throw new Error(`Invalid version format: ${currentVersion}`);
  }

  const [, major, minor, patch, prereleaseId, prereleaseNum] = match;
  let majorNum = Number.parseInt(major, 10);
  let minorNum = Number.parseInt(minor, 10);
  let patchNum = Number.parseInt(patch, 10);

  switch (versionType) {
    case "major":
      majorNum++;
      minorNum = 0;
      patchNum = 0;
      return `${majorNum}.${minorNum}.${patchNum}`;

    case "minor":
      minorNum++;
      patchNum = 0;
      return `${majorNum}.${minorNum}.${patchNum}`;

    case "patch":
      patchNum++;
      return `${majorNum}.${minorNum}.${patchNum}`;

    case "prerelease": {
      const id = preid || prereleaseId || "beta";
      if (prereleaseId === id && prereleaseNum !== undefined) {
        // Increment prerelease number
        return `${majorNum}.${minorNum}.${patchNum}-${id}.${Number.parseInt(prereleaseNum, 10) + 1}`;
      }
      // Start new prerelease
      return `${majorNum}.${minorNum}.${patchNum}-${id}.0`;
    }

    default:
      throw new Error(`Unknown version type: ${versionType}`);
  }
}

/**
 * Bump version by directly modifying package.json (avoids npm version issues with workspace:*)
 */
async function bumpVersion(
  pkgPath: string,
  name: string,
  versionType: VersionType,
  preid?: string,
  dryRun?: boolean,
): Promise<{ success: boolean; newVersion?: string }> {
  const pkgJsonPath = join(process.cwd(), pkgPath, "package.json");

  try {
    // Read current package.json
    const pkgJsonContent = await Bun.file(pkgJsonPath).text();
    const pkgJson = JSON.parse(pkgJsonContent);
    const currentVersion = pkgJson.version;

    // Calculate new version
    const newVersion = calculateNextVersion(currentVersion, versionType, preid);

    console.log(`${dryRun ? "[DRY RUN] " : ""}Bumping ${name} (${versionType})...`);
    console.log(`  ${currentVersion} -> ${newVersion}`);

    if (dryRun) {
      console.log("");
      return { success: true, newVersion };
    }

    // Update version in package.json
    pkgJson.version = newVersion;

    // Write back with proper formatting (preserve tabs from original)
    await Bun.write(pkgJsonPath, `${JSON.stringify(pkgJson, null, "\t")}\n`);

    console.log(`  Updated ${name}@${newVersion}\n`);
    return { success: true, newVersion };
  } catch (error) {
    console.error(`Version bump failed for ${name}:`, error);
    return { success: false };
  }
}

async function buildPackage(pkgPath: string, name: string, dryRun: boolean): Promise<boolean> {
  console.log(`${dryRun ? "[DRY RUN] " : ""}Building ${name}...`);

  if (dryRun) {
    console.log(`  Skipped (dry run)\n`);
    return true;
  }

  const result = await runCommand(pkgPath, "bun", ["run", "build"]);

  if (!result.success) {
    console.error(`Build failed for ${name}\n`);
    return false;
  }

  console.log(`Built ${name}\n`);
  return true;
}

async function publishPackage(
  pkgPath: string,
  name: string,
  version: string,
  dryRun: boolean,
  tag?: string,
  otp?: string,
): Promise<boolean> {
  const args = ["publish", "--access", "public"];

  if (tag) {
    args.push("--tag", tag);
  }

  if (otp) {
    args.push("--otp", otp);
  }

  console.log(
    `${dryRun ? "[DRY RUN] " : ""}Publishing ${name}@${version}${tag ? ` with tag "${tag}"` : ""}...`,
  );

  if (dryRun) {
    console.log(`  Skipped (dry run)\n`);
    return true;
  }

  // Use `bun publish` (not `npm publish`): bun rewrites the `workspace:*`
  // protocol in dependencies to the real version at publish time. npm leaves
  // `workspace:*` literal, which breaks every external consumer.
  const result = await runCommand(pkgPath, "bun", args);

  if (!result.success) {
    console.error(`Publish failed for ${name}\n`);
    return false;
  }

  console.log(`Published ${name}@${version}\n`);
  return true;
}

async function main() {
  const options = parseArgs();

  if (!options) {
    process.exit(0);
  }

  console.log("\n--- Publish Plan ---\n");
  console.log("Packages:", options.packages.join(", "));
  console.log("Dry run:", options.dryRun ? "yes" : "no");
  console.log("Skip build:", options.skipBuild ? "yes" : "no");
  if (options.tag) {
    console.log("Tag:", options.tag);
  }
  if (options.otp) {
    console.log("OTP:", "***");
  }
  if (options.version) {
    console.log("Version bump:", options.version);
    if (options.preid) {
      console.log("Preid:", options.preid);
    }
  }
  console.log("");

  // Check npm auth (skip in dry-run)
  if (!options.dryRun) {
    const isAuthenticated = await checkNpmAuth();
    if (!isAuthenticated) {
      process.exit(1);
    }
  }

  // Get package info
  let packagesInfo = await Promise.all(
    options.packages.map(async (pkg) => ({
      key: pkg,
      path: PACKAGES[pkg],
      ...(await getPackageInfo(PACKAGES[pkg])),
    })),
  );

  console.log("Packages to publish:\n");
  for (const pkg of packagesInfo) {
    console.log(`  - ${pkg.name}@${pkg.version}`);
  }
  console.log("");

  // Bump versions if requested
  if (options.version) {
    console.log("--- Bumping Versions ---\n");

    for (const pkg of packagesInfo) {
      const result = await bumpVersion(
        pkg.path,
        pkg.name,
        options.version,
        options.preid,
        options.dryRun,
      );
      if (!result.success) {
        process.exit(1);
      }
      // Update version in packagesInfo for dry-run display
      if (result.newVersion) {
        pkg.version = result.newVersion;
      }
    }

    // Re-read package info after version bump (unless dry-run)
    if (!options.dryRun) {
      packagesInfo = await Promise.all(
        options.packages.map(async (pkg) => ({
          key: pkg,
          path: PACKAGES[pkg],
          ...(await getPackageInfo(PACKAGES[pkg])),
        })),
      );
    }

    console.log("Updated versions:\n");
    for (const pkg of packagesInfo) {
      console.log(`  - ${pkg.name}@${pkg.version}`);
    }
    console.log("");
  }

  // Build packages
  if (!options.skipBuild) {
    console.log("--- Building Packages ---\n");

    for (const pkg of packagesInfo) {
      const success = await buildPackage(pkg.path, pkg.name, options.dryRun);
      if (!success) {
        process.exit(1);
      }
    }
  }

  // Publish packages
  console.log("--- Publishing Packages ---\n");

  const results: { name: string; version: string; success: boolean }[] = [];

  for (const pkg of packagesInfo) {
    const success = await publishPackage(
      pkg.path,
      pkg.name,
      pkg.version,
      options.dryRun,
      options.tag,
      options.otp,
    );
    results.push({ name: pkg.name, version: pkg.version, success });

    if (!success && !options.dryRun) {
      console.error("Stopping due to publish failure\n");
      break;
    }
  }

  // Summary
  console.log("\n--- Summary ---\n");

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (successful.length > 0) {
    console.log(`${options.dryRun ? "Would publish" : "Published"} (${successful.length}):`);
    for (const r of successful) {
      console.log(`   - ${r.name}@${r.version}`);
    }
  }

  if (failed.length > 0) {
    console.log(`Failed (${failed.length}):`);
    for (const r of failed) {
      console.log(`   - ${r.name}`);
    }
    process.exit(1);
  }

  if (options.dryRun) {
    console.log("\nThis was a dry run. Run without --dry-run to publish.\n");
  } else {
    console.log("\nAll packages published successfully!\n");
  }
}

main();
