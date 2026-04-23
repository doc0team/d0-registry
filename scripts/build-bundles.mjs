import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as tar from "tar";
import { put } from "@vercel/blob";

const REGISTRY_URL =
  process.env.D0_REGISTRY_URL ??
  "https://raw.githubusercontent.com/doc0team/d0-registry/main/registry.json";
const OUT_ROOT = process.env.D0_BUNDLE_OUT_DIR ?? path.resolve(".artifacts");
const CDN_BASE = process.env.D0_CDN_BASE_URL ?? "https://doc0.sh/cdn";
const EMBED_DIM = Number.parseInt(process.env.D0_EMBED_DIM ?? "384", 10);

async function exec(cmd, args, opts = {}) {
  await new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function stableHash(input) {
  return createHash("sha256").update(input).digest("hex");
}

function asRegistryEntries(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.entries)) return raw.entries;
  return [];
}

async function fetchRegistry() {
  const res = await fetch(REGISTRY_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status} ${res.statusText}`);
  const body = await res.json();
  return asRegistryEntries(body)
    .filter((e) => e && typeof e.id === "string" && e.sourceType === "url" && typeof e.source === "string")
    .map((e) => ({
      id: String(e.id).trim().toLowerCase(),
      source: String(e.snapshotUrl || e.source).trim(),
      version: typeof e.version === "string" && e.version.trim() ? e.version.trim() : undefined,
      versions: Array.isArray(e.versions) ? e.versions.map((v) => String(v)).filter(Boolean) : [],
      embedModel: typeof e.embedModel === "string" ? e.embedModel : undefined,
      build: e.build && typeof e.build === "object" ? e.build : {},
    }));
}

async function ensureIngested(sourceUrl, opts = {}) {
  const doc0Bin = process.env.D0_DOC0_BIN?.trim();
  const envMaxRaw = Number.parseInt(process.env.D0_BUILD_MAX_PAGES ?? "", 10);
  const envMax = Number.isFinite(envMaxRaw) && envMaxRaw > 0 ? envMaxRaw : undefined;
  const maxPages = String(opts.maxPages ?? envMax ?? 50000);
  const attempts = doc0Bin
    ? [
        ["node", [doc0Bin, "contrib", "ingest", "url", sourceUrl, "--json", "--max-pages", maxPages]],
        ["node", [doc0Bin, "ingest", "url", sourceUrl, "--json", "--max-pages", maxPages]],
      ]
    : [
        ["npx", ["-y", "doczero@latest", "contrib", "ingest", "url", sourceUrl, "--json", "--max-pages", maxPages]],
        ["npx", ["-y", "doczero@latest", "ingest", "url", sourceUrl, "--json", "--max-pages", maxPages]],
      ];

  let lastErr = null;
  for (const [cmd, args] of attempts) {
    const chunks = [];
    const { code } = await new Promise((resolve) => {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
      p.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
      p.stderr.on("data", (d) => process.stderr.write(d));
      p.on("exit", (exitCode) => resolve({ code: exitCode ?? 1 }));
    });
    if (code !== 0) {
      lastErr = new Error(`ingest failed via: ${cmd} ${args.join(" ")} (exit ${code})`);
      continue;
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    try {
      const jsonTail = raw.match(/\{[\s\S]*\}\s*$/)?.[0] ?? raw;
      const out = JSON.parse(jsonTail);
      if (out?.storeId) return out.storeId;
      lastErr = new Error(`ingest output missing storeId for ${sourceUrl}`);
    } catch {
      const txtStore = raw.match(/store:\s*([a-f0-9]{8,64})/i)?.[1];
      if (txtStore) return txtStore;
      lastErr = new Error(`ingest returned non-JSON output for ${sourceUrl}`);
    }
  }
  throw lastErr ?? new Error(`ingest failed (${sourceUrl})`);
}

async function buildOne(entry, version) {
  const storeId = await ensureIngested(entry.source, { maxPages: entry.build.maxPages });
  const storeRoot = path.join(process.env.USERPROFILE || process.env.HOME || "", ".d0", "docs-store", storeId);
  const manifestPath = path.join(storeRoot, "manifest.json");
  const rawManifest = await readFile(manifestPath, "utf8");
  const docStoreManifest = JSON.parse(rawManifest);
  const pages = docStoreManifest.pages ?? {};

  const tmp = path.join(tmpdir(), `d0-bundle-${entry.id}-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  await cp(path.join(storeRoot, "pages"), path.join(tmp, "pages"), { recursive: true });
  await writeFile(path.join(tmp, "manifest.json"), JSON.stringify(docStoreManifest, null, 2));

  const structure = {};
  const pageKeys = Object.keys(pages).sort();
  for (const key of pageKeys) structure[key.replace(/^\//, "")] = pages[key].relPath;
  const d0 = {
    name: `@doc0/${entry.id}`,
    version,
    structure,
  };
  await writeFile(path.join(tmp, "d0.json"), JSON.stringify(d0, null, 2) + "\n");

  // Placeholder vector index; future runs can replace with real embeddings.
  const vectors = Buffer.alloc(pageKeys.length * EMBED_DIM * 4, 0);
  await writeFile(path.join(tmp, "vectors.f32"), vectors);
  await writeFile(
    path.join(tmp, "vectors.meta.json"),
    JSON.stringify(
      {
        model: entry.embedModel ?? "Xenova/all-MiniLM-L6-v2",
        dim: EMBED_DIM,
        pageOrder: pageKeys,
      },
      null,
      2,
    ),
  );

  const tarPath = path.join(OUT_ROOT, `${entry.id}-${version}.d0.tgz`);
  await mkdir(OUT_ROOT, { recursive: true });
  await tar.create({ gzip: true, cwd: tmp, file: tarPath }, ["d0.json", "manifest.json", "pages", "vectors.f32", "vectors.meta.json"]);
  const tarBuf = await readFile(tarPath);
  const sha = stableHash(tarBuf);
  const finalName = `${sha}.d0.tgz`;
  const finalPath = path.join(OUT_ROOT, finalName);
  await writeFile(finalPath, tarBuf);

  const manifestUrlPath = `bundles/${entry.id}/${version}/${sha}.manifest.json`;
  const vectorMetaUrlPath = `bundles/${entry.id}/${version}/${sha}.vectors.meta.json`;
  const tarUrlPath = `bundles/${entry.id}/${version}/${finalName}`;
  let tarUrl = `${CDN_BASE}/${tarUrlPath}`;
  let manifestUrl = `${CDN_BASE}/${manifestUrlPath}`;
  let pagesBaseUrl = `${CDN_BASE}/bundles/${entry.id}/${version}/${sha}`;

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const [tarObj, manifestObj] = await Promise.all([
      put(tarUrlPath, tarBuf, { access: "public", addRandomSuffix: false }),
      put(manifestUrlPath, rawManifest, { access: "public", addRandomSuffix: false }),
    ]);
    await put(vectorMetaUrlPath, await readFile(path.join(tmp, "vectors.meta.json")), {
      access: "public",
      addRandomSuffix: false,
    });
    const uploads = pageKeys.map(async (k) => {
      const relPath = pages[k].relPath;
      const content = await readFile(path.join(storeRoot, relPath), "utf8");
      const blobPath = `bundles/${entry.id}/${version}/${sha}/${relPath}`;
      await put(blobPath, content, { access: "public", addRandomSuffix: false });
    });
    await Promise.all(uploads);
    tarUrl = tarObj.url;
    manifestUrl = manifestObj.url;
  }

  await rm(tmp, { recursive: true, force: true });
  return {
    version,
    sha,
    url: tarUrl,
    manifestUrl,
    pages: pageKeys.length,
    builtAt: new Date().toISOString(),
    embedModel: entry.embedModel ?? "Xenova/all-MiniLM-L6-v2",
    embedDim: EMBED_DIM,
    pagesBaseUrl,
  };
}

async function main() {
  await mkdir(OUT_ROOT, { recursive: true });
  const onlyId = process.env.D0_BUILD_ONLY_ID?.trim().toLowerCase();
  const allEntries = await fetchRegistry();
  const entries = onlyId ? allEntries.filter((e) => e.id === onlyId) : allEntries;
  if (onlyId && entries.length === 0) {
    throw new Error(`D0_BUILD_ONLY_ID=${onlyId} was not found in registry`);
  }
  const index = { builtAt: new Date().toISOString(), entries: {} };

  for (const entry of entries) {
    if (entry.build?.disabled === true) continue;
    const versions = entry.versions.length
      ? entry.versions
      : [entry.version || new Date().toISOString().slice(0, 10)];
    const builtVersions = {};
    for (const version of versions) {
      const built = await buildOne(entry, version);
      builtVersions[version] = built;
    }
    const latest = versions[0];
    index.entries[entry.id] = { latest, versions: builtVersions };
    await writeFile(path.join(OUT_ROOT, `${entry.id}.json`), JSON.stringify(index.entries[entry.id], null, 2));
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      await put(`api/bundles/${entry.id}.json`, JSON.stringify(index.entries[entry.id], null, 2), {
        access: "public",
        addRandomSuffix: false,
      });
    }
  }

  const indexBody = JSON.stringify(index, null, 2);
  await writeFile(path.join(OUT_ROOT, "index.json"), indexBody);
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    await put("api/bundles/index.json", indexBody, { access: "public", addRandomSuffix: false });
  }
}

main().catch((err) => {
  console.error("[build-bundles] failed:", err);
  process.exit(1);
});
