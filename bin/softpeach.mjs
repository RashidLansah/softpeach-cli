#!/usr/bin/env node

import { tunnel } from "cloudflared";
import { execSync } from "child_process";
import { randomBytes } from "crypto";

const SOFTPEACH_URL = process.env.SOFTPEACH_URL || "https://softpeach-w2zu.onrender.com";

function printBanner() {
  console.log("");
  console.log("  \x1b[38;5;209m\x1b[1m🍑 SoftPeach\x1b[0m — Share your localhost for design review");
  console.log("");
}

function printHelp() {
  printBanner();
  console.log("  \x1b[1mUsage:\x1b[0m");
  console.log("    npx softpeach-cli share <port> [--room <name>]");
  console.log("");
  console.log("  \x1b[1mExamples:\x1b[0m");
  console.log("    npx softpeach-cli share 3000");
  console.log("    npx softpeach-cli share 5173 --room my-project");
  console.log("    npx softpeach-cli share 8080 --room sprint-review");
  console.log("");
  console.log("  \x1b[1mOptions:\x1b[0m");
  console.log("    share <port>       Tunnel localhost:<port> and open SoftPeach");
  console.log("    --room <name>      Use a specific room name (default: random)");
  console.log("    --no-open          Don't auto-open the browser");
  console.log("    --help             Show this help message");
  console.log("");
}

function openBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === "darwin") execSync(`open "${url}"`);
    else if (platform === "win32") execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {
    // Silently fail — user can open manually
  }
}

function generateRoomId() {
  return randomBytes(4).toString("hex");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  if (command !== "share") {
    console.error(`\n  \x1b[31mUnknown command: ${command}\x1b[0m`);
    printHelp();
    process.exit(1);
  }

  const port = parseInt(args[1]);
  if (!port || isNaN(port)) {
    console.error("\n  \x1b[31mPlease specify a port number.\x1b[0m");
    console.log("  Example: npx softpeach-cli share 3000\n");
    process.exit(1);
  }

  // Parse options
  let roomId = generateRoomId();
  let autoOpen = true;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--room" && args[i + 1]) {
      roomId = args[++i];
    } else if (args[i] === "--no-open") {
      autoOpen = false;
    }
  }

  printBanner();
  console.log(`  \x1b[2mPort:\x1b[0m     localhost:${port}`);
  console.log(`  \x1b[2mRoom:\x1b[0m     ${roomId}`);
  console.log("");

  // Check if the port is actually running
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);
    await fetch(`http://localhost:${port}`, { signal: controller.signal, mode: "no-cors" });
  } catch {
    console.log(`  \x1b[33m⚠ Warning:\x1b[0m Nothing seems to be running on localhost:${port}`);
    console.log(`  \x1b[2mMake sure your dev server is running first.\x1b[0m`);
    console.log("");
  }

  console.log("  \x1b[36m⟳\x1b[0m Starting tunnel...");

  try {
    const { url, stop, connections } = tunnel({ "--url": `http://localhost:${port}` });

    const tunnelUrl = await url;

    // Wait for tunnel to be actually routable before opening browser
    console.log(`  \x1b[36m⟳\x1b[0m Waiting for tunnel to be reachable...`);
    let tunnelReady = false;
    for (let i = 0; i < 15; i++) {
      try {
        const check = await fetch(tunnelUrl, { signal: AbortSignal.timeout(3000), redirect: "follow" });
        if (check.ok || check.status < 500) {
          tunnelReady = true;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!tunnelReady) {
      console.log(`  \x1b[33m⚠\x1b[0m Tunnel URL may not be ready yet, opening anyway...`);
    }

    console.log(`  \x1b[32m✓\x1b[0m Tunnel ready: \x1b[4m${tunnelUrl}\x1b[0m`);
    console.log("");

    const roomUrl = `${SOFTPEACH_URL}/room/${roomId}?url=${encodeURIComponent(tunnelUrl)}`;

    if (autoOpen) {
      console.log("  \x1b[36m⟳\x1b[0m Opening SoftPeach in your browser...");
      openBrowser(roomUrl);
    }

    console.log("");
    console.log("  \x1b[1m\x1b[32m● Live!\x1b[0m Share this with your team:");
    console.log("");
    console.log(`  \x1b[4m${SOFTPEACH_URL}/room/${roomId}\x1b[0m`);
    console.log("");
    console.log(`  \x1b[2mRoom code: ${roomId}\x1b[0m`);
    console.log(`  \x1b[2mTunnel:    ${tunnelUrl}\x1b[0m`);
    console.log("");
    console.log("  \x1b[2mPress Ctrl+C to stop sharing.\x1b[0m");
    console.log("");

    // Keep the process alive until interrupted
    process.on("SIGINT", () => {
      console.log("\n  \x1b[33m■\x1b[0m Shutting down tunnel...");
      stop();
      console.log("  \x1b[32m✓\x1b[0m Done. Thanks for using SoftPeach!\n");
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      stop();
      process.exit(0);
    });

    // Keep alive
    await new Promise(() => {});

  } catch (err) {
    console.error(`\n  \x1b[31m✗ Failed to start tunnel:\x1b[0m ${err.message}`);
    console.log("");
    console.log("  \x1b[2mMake sure cloudflared is accessible. You can install it:\x1b[0m");
    console.log("  \x1b[2m  brew install cloudflared\x1b[0m");
    console.log("  \x1b[2m  or visit: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\x1b[0m");
    console.log("");
    process.exit(1);
  }
}

main();
