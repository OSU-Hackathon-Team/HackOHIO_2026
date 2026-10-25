import JSZip from "jszip";
import type { SynthesisBundle } from "@splice/contracts";

export interface ElectronProject {
  files: Record<string, string>;
  filename: string;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "splice-app";
}

/** Turn a verified Sandpack bundle into a standalone Electron source project. */
export function createElectronProject(bundle: SynthesisBundle, title = bundle.app_title): ElectronProject {
  if (!bundle.files["/App.tsx"] || !bundle.files["/index.tsx"]) {
    throw new Error("The bundle has no runnable React entry point");
  }
  if (!bundle.engine_paths.length || bundle.engine_paths.some(path => !bundle.files[path])) {
    throw new Error("The bundle is missing a verified engine file");
  }

  const name = slug(title);
  const files: Record<string, string> = {};
  for (const [sourcePath, content] of Object.entries(bundle.files)) {
    if (sourcePath === "/public/index.html") continue;
    if (!/^\/(?:index\.tsx|styles\.css|App\.tsx|(?:components|lib|data|engines)\/[A-Za-z0-9_/-]+\.(?:ts|tsx))$/.test(sourcePath) ||
      sourcePath.split("/").includes("..")) {
      throw new Error(`Unexpected bundle path: ${sourcePath}`);
    }
    files[`src${sourcePath}`] = content;
  }

  files["package.json"] = JSON.stringify({
    name, version: "1.0.0", private: true, type: "module", main: "electron/main.cjs",
    scripts: { build: "tsc --noEmit && vite build", start: "npm run build && electron ." },
    dependencies: bundle.dependencies,
    devDependencies: {
      "@types/canvas-confetti": "1.9.0",
      "@types/react": "18.3.12",
      "@types/react-dom": "18.3.1",
      "@vitejs/plugin-react": "4.3.4",
      autoprefixer: "10.4.20",
      electron: "45.0.0",
      postcss: "8.5.2",
      tailwindcss: "3.4.17",
      typescript: "5.7.3",
      vite: "6.1.0",
    },
  }, null, 2) + "\n";
  files["index.html"] = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'">
<title>${title.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)}</title></head>
<body><div id="root"></div><script type="module" src="/src/index.tsx"></script></body></html>\n`;
  files["vite.config.ts"] = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ base: "./", plugins: [react()] });
`;
  files["tsconfig.json"] = JSON.stringify({ compilerOptions: {
    target: "ES2022", lib: ["ES2022", "DOM"], module: "ESNext", moduleResolution: "Bundler",
    jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
    esModuleInterop: true,
  }, include: ["src", "vite.config.ts"] }, null, 2) + "\n";
  files["postcss.config.cjs"] = `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`;
  files["tailwind.config.cjs"] = `module.exports = { content: ["./index.html", "./src/**/*.{ts,tsx}"], theme: { extend: {} }, plugins: [] };\n`;
  files["src/styles.css"] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n${files["src/styles.css"] ?? ""}`;
  files["electron/main.cjs"] = `const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 760,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
`;
  files["README.md"] = `# ${title}\n\n${bundle.app_description}\n\nGenerated from Splice bundle ${bundle.bundle_id}, revision ${bundle.revision} (${bundle.mode}).\nThe selected feature engines are in \`src/engines/\`. This project supplies an Electron window for the generated UI; it does not recreate the source application's Electron main process, IPC, storage, or other platform behavior that was excluded from the feature specs.\n\n## Run\n\nRequires Node.js 22 or newer. Run \`npm install\`, then \`npm start\`. The start command type-checks and builds the renderer before launching Electron.\n`;
  return { files, filename: `${name}-electron-rev${bundle.revision}.zip` };
}

export async function exportElectronProject(bundle: SynthesisBundle, title = bundle.app_title): Promise<void> {
  const project = createElectronProject(bundle, title);
  const zip = new JSZip();
  for (const [path, content] of Object.entries(project.files)) zip.file(path, content);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = project.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
