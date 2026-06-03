#!/usr/bin/env bun

import { join } from "node:path";
import { spawn } from "bun";

const PACKAGES = [
  "packages/frame",
  "packages/frame-angular",
  "packages/frame-react",
  "packages/frame-solid",
  "packages/frame-vue",
];

const APPS = [
  "apps/shell-angular",
  "apps/app-angular",
  "apps/app-react",
  "apps/app-vue",
  "apps/shell-solid",
  "apps/app-excalidraw",
];

interface BuildOptions {
  watch: boolean;
  packagesOnly: boolean;
  appsOnly: boolean;
}

function parseArgs(): BuildOptions {
  const args = process.argv.slice(2);
  return {
    watch: args.includes("--watch"),
    packagesOnly: args.includes("--packages-only"),
    appsOnly: args.includes("--apps-only"),
  };
}

interface RunCommandResult {
  proc: ReturnType<typeof spawn>;
  label: string;
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[],
  label: string,
  isWatch: boolean,
): Promise<RunCommandResult> {
  const fullPath = join(process.cwd(), cwd);

  console.log(`[${label}] Starting ${isWatch ? "watch mode" : "build"}...`);

  const proc = spawn([command, ...args], {
    cwd: fullPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream output with label
  const decoder = new TextDecoder();

  // Handle stdout in background
  (async () => {
    if (proc.stdout) {
      for await (const chunk of proc.stdout) {
        const text = decoder.decode(chunk).trim();
        if (text) {
          console.log(`[${label}] ${text}`);
        }
      }
    }
  })();

  // Handle stderr in background
  (async () => {
    if (proc.stderr) {
      for await (const chunk of proc.stderr) {
        const text = decoder.decode(chunk).trim();
        if (text) {
          console.error(`[${label}] ${text}`);
        }
      }
    }
  })();

  if (!isWatch) {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`[${label}] Build failed with exit code ${exitCode}`);
    }
  }

  return { proc, label };
}

async function buildPackages(watch: boolean): Promise<RunCommandResult[]> {
  console.log(`\n🔨 ${watch ? "Watch mode" : "Building"} packages...\n`);

  const promises = PACKAGES.map((pkg) => {
    const name = pkg.split("/")[1];
    const command = watch ? "dev" : "build";

    return runCommand(pkg, "bun", ["run", command], name, watch);
  });

  const results = await Promise.all(promises);

  if (!watch) {
    console.log("\n✅ All packages built successfully!\n");
  }

  return results;
}

async function buildApps(watch: boolean): Promise<RunCommandResult[]> {
  console.log(`\n🚀 ${watch ? "Starting" : "Building"} apps...\n`);

  const promises = APPS.map((app) => {
    const name = app.split("/")[1];
    const command = watch ? "dev" : "build";

    return runCommand(app, "bun", ["run", command], name, watch);
  });

  const results = await Promise.all(promises);

  if (!watch) {
    console.log("\n✅ All apps built successfully!\n");
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPackageReady(results: RunCommandResult[]): Promise<void> {
  // Wait for ng-packagr to complete initial build (it prints "Compilation complete")
  // Give packages time to finish their initial compilation
  const INITIAL_BUILD_DELAY = 3000;
  console.log(`\n⏳ Waiting ${INITIAL_BUILD_DELAY}ms for packages to complete initial build...\n`);
  await sleep(INITIAL_BUILD_DELAY);
}

async function main() {
  const options = parseArgs();

  try {
    if (options.appsOnly) {
      await buildApps(options.watch);
      // Keep process alive in watch mode
      if (options.watch) {
        await new Promise(() => {}); // Never resolves
      }
    } else if (options.packagesOnly) {
      await buildPackages(options.watch);
      // Keep process alive in watch mode
      if (options.watch) {
        await new Promise(() => {}); // Never resolves
      }
    } else if (!options.watch) {
      // Build packages first (sequential)
      await buildPackages(false);
      await buildApps(false);
    } else {
      // In watch mode: start packages first, wait for initial build, then start apps
      const packageResults = await buildPackages(true);

      // Wait for packages to complete their initial build
      await waitForPackageReady(packageResults);

      // Now start apps
      await buildApps(true);

      // Keep process alive
      await new Promise(() => {}); // Never resolves
    }
  } catch (error) {
    console.error("\n❌ Build failed:", error);
    process.exit(1);
  }
}

main();
