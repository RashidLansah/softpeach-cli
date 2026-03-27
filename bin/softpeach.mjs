#!/usr/bin/env node

import { tunnel } from "cloudflared";
import { execSync } from "child_process";
import { randomBytes } from "crypto";
import http from "http";

const SOFTPEACH_URL = process.env.SOFTPEACH_URL || "https://softpeach-w2zu.onrender.com";

// Script injected into HTML responses to enable SoftPeach features:
// - Scroll position reporting via postMessage
// - Scroll-to command handling (click comment in sidebar → scroll to it)
// - Element context queries (for AI prompt generation)
const HELPER_SCRIPT = `<script data-softpeach-helper>
(function(){
  var lx=-1,ly=-1;
  function report(){
    var sx=window.scrollX||window.pageXOffset||0;
    var sy=window.scrollY||window.pageYOffset||0;
    var cw=document.documentElement.scrollWidth;
    var ch=document.documentElement.scrollHeight;
    if(sx!==lx||sy!==ly){
      lx=sx;ly=sy;
      parent.postMessage({type:"softpeach-scroll",scrollX:sx,scrollY:sy,contentWidth:cw,contentHeight:ch},"*");
    }
    requestAnimationFrame(report);
  }
  requestAnimationFrame(report);
  window.addEventListener("load",function(){
    setTimeout(function(){
      var sx=window.scrollX||0,sy=window.scrollY||0;
      parent.postMessage({type:"softpeach-scroll",scrollX:sx,scrollY:sy,
        contentWidth:document.documentElement.scrollWidth,
        contentHeight:document.documentElement.scrollHeight},"*");
    },100);
  });
  window.addEventListener("message",function(e){
    if(!e.data)return;
    if(e.data.type==="softpeach-scroll-to"){
      window.scrollTo({left:e.data.scrollX||0,top:e.data.scrollY||0,behavior:"smooth"});
    }
    if(e.data.type==="softpeach-element-query"){
      var el=document.elementFromPoint(e.data.x,e.data.y);
      var ctx="";
      if(el){
        var tag=el.tagName.toLowerCase();
        var txt=(el.textContent||"").trim().substring(0,50);
        var sec=el.closest("section,main,header,footer,nav,aside,article");
        var sid=sec?(sec.tagName.toLowerCase()+(sec.id?"#"+sec.id:sec.className?" ."+sec.className.split(" ")[0]:"")):"";
        ctx="<"+tag+">"+(txt?' "'+txt+'"':"")+(sid?" in <"+sid+">":"");
      }
      parent.postMessage({type:"softpeach-element-result",id:e.data.id,context:ctx},"*");
    }
  });
})();
</script>`;

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

/**
 * Creates a local HTTP proxy that forwards requests to the target port
 * and injects the SoftPeach helper script into HTML responses.
 * This enables scroll tracking, click-to-scroll, and element context
 * detection when the page is loaded in SoftPeach's iframe.
 */
function createInjectingProxy(targetPort) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const targetUrl = `http://localhost:${targetPort}${req.url}`;

      try {
        // Collect request body for non-GET requests
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

        // Forward headers, fixing the host
        const headers = { ...req.headers, host: `localhost:${targetPort}` };
        delete headers["accept-encoding"]; // Don't accept compressed responses — we need to read HTML

        const resp = await fetch(targetUrl, {
          method: req.method,
          headers,
          body,
          redirect: "follow",
        });

        const contentType = resp.headers.get("content-type") || "";

        if (contentType.includes("text/html")) {
          let html = await resp.text();

          // Inject helper script — before </head> if possible, otherwise before </body>
          if (html.includes("</head>")) {
            html = html.replace("</head>", HELPER_SCRIPT + "</head>");
          } else if (html.includes("</body>")) {
            html = html.replace("</body>", HELPER_SCRIPT + "</body>");
          } else if (html.includes("</HEAD>")) {
            html = html.replace("</HEAD>", HELPER_SCRIPT + "</HEAD>");
          } else {
            html += HELPER_SCRIPT;
          }

          // Forward relevant response headers
          const respHeaders = { "content-type": contentType };
          const cacheControl = resp.headers.get("cache-control");
          if (cacheControl) respHeaders["cache-control"] = cacheControl;

          res.writeHead(resp.status, respHeaders);
          res.end(html);
        } else {
          // Non-HTML: proxy as-is
          const buffer = Buffer.from(await resp.arrayBuffer());
          const respHeaders = { "content-type": contentType };
          const cacheControl = resp.headers.get("cache-control");
          if (cacheControl) respHeaders["cache-control"] = cacheControl;

          res.writeHead(resp.status, respHeaders);
          res.end(buffer);
        }
      } catch (err) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`SoftPeach proxy error: ${err.message}`);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const proxyPort = server.address().port;
      resolve({ proxyPort, server });
    });

    server.on("error", reject);
  });
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

  // Start local proxy that injects SoftPeach helper script
  console.log("  \x1b[36m⟳\x1b[0m Starting helper proxy...");
  let proxyPort;
  let proxyServer;
  try {
    const proxy = await createInjectingProxy(port);
    proxyPort = proxy.proxyPort;
    proxyServer = proxy.server;
    console.log(`  \x1b[32m✓\x1b[0m Helper proxy running on port ${proxyPort}`);
  } catch (err) {
    console.error(`  \x1b[31m✗ Failed to start helper proxy:\x1b[0m ${err.message}`);
    process.exit(1);
  }

  console.log("  \x1b[36m⟳\x1b[0m Starting tunnel...");

  try {
    // Tunnel to the proxy, not directly to the dev server
    const { url, stop, connections } = tunnel({ "--url": `http://localhost:${proxyPort}` });

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
      console.log("\n  \x1b[33m■\x1b[0m Shutting down...");
      stop();
      proxyServer.close();
      console.log("  \x1b[32m✓\x1b[0m Done. Thanks for using SoftPeach!\n");
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      stop();
      proxyServer.close();
      process.exit(0);
    });

    // Keep alive
    await new Promise(() => {});

  } catch (err) {
    proxyServer.close();
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
