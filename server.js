// Vendor Finder — Notion live sync server
// 사용법:
//   1) npm install
//   2) .env 파일에 NOTION_TOKEN, ESTIMATES_DB_ID, VENDORS_DB_ID 입력
//   3) node server.js  →  http://localhost:5173
//
// 동작:
//   - GET /                → vendor-finder-v2.html
//   - GET /api/vendors     → 두 노션 DB를 합쳐 정규화된 JSON 반환 (15초 캐시)
//   - GET /vendors.json    → 정적 스냅샷 (서버 미실행/토큰 없음 시 fallback)
//
// Notion에서 데이터 추가/수정 시 다음 폴링 사이클에 자동 반영됩니다.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@notionhq/client";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 5173);
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ESTIMATES_DB_ID =
  process.env.ESTIMATES_DB_ID || "295a597878a080d1b44ef1a59bf0bb10";
const VENDORS_DB_ID =
  process.env.VENDORS_DB_ID || "2c5a597878a0806b96e9ccf68f2d9cf0";

const notion = NOTION_TOKEN ? new Client({ auth: NOTION_TOKEN }) : null;

// ── In-memory cache ─────────────────────────────────────────────
let cache = { at: 0, data: null };
const CACHE_TTL_MS = 2_000; // 2초 캐시 (Notion API rate limit 보호)

// ── Helpers ─────────────────────────────────────────────────────
const stripStatusEmoji = (s = "") =>
  s.replace(/^\s*(?:🟢|🟠|🔴|⚠️)\s*/u, "").trim();

const detectStatus = (rawName = "", note = "") => {
  if (rawName.includes("🟢")) return "green";
  if (rawName.includes("🟠")) return "orange";
  if (/불량|사용\s*x|사용\s*X/.test(note)) return "warn";
  return "none";
};

const readTitle = (prop) =>
  prop?.title?.map((t) => t.plain_text).join("") || "";
const readText = (prop) =>
  prop?.rich_text?.map((t) => t.plain_text).join("") || "";
const readNumber = (prop) => (prop?.number ?? null);
const readMulti = (prop) => prop?.multi_select?.map((o) => o.name) || [];
const readSelect = (prop) => prop?.select?.name || null;
const readUrl = (prop) => prop?.url || null;
const readPhone = (prop) => prop?.phone_number || null;

// Notion 'files' 프로퍼티 → [{ name, kind, isExternal }]
// 실제 다운로드 URL 은 /api/file 프록시가 매번 fresh 로 가져옴
// kind: "pdf" | "image" | "doc" | "spreadsheet" | "other"
function readFiles(prop) {
  if (!prop?.files) return [];
  return prop.files.map((f) => {
    const name = f.name || "untitled";
    const isExternal = f.type === "external";
    const hasUrl =
      (f.type === "external" && f.external?.url) ||
      (f.type === "file" && f.file?.url);
    if (!hasUrl) return null;
    const ext = (name.split(".").pop() || "").toLowerCase();
    let kind = "other";
    if (ext === "pdf") kind = "pdf";
    else if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) kind = "image";
    else if (["doc", "docx", "hwp", "txt", "md"].includes(ext)) kind = "doc";
    else if (["xls", "xlsx", "csv", "numbers"].includes(ext)) kind = "spreadsheet";
    return { name, kind, isExternal };
  }).filter(Boolean);
}

// 한 페이지에서 파일 이름으로 매칭해 fresh signed URL 을 가져옴
async function resolveFileUrl(pageId, fileName) {
  if (!notion) throw new Error("NOTION_TOKEN not set");
  const page = await notion.pages.retrieve({ page_id: pageId });
  const props = page.properties || {};
  // 파일 컬럼은 보통 "파일과 미디어" 지만 다른 이름일 수도 있어 모든 files-type 컬럼 검색
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type !== "files" || !Array.isArray(prop.files)) continue;
    for (const f of prop.files) {
      if ((f.name || "") !== fileName) continue;
      if (f.type === "external" && f.external?.url) return { url: f.external.url, isExternal: true };
      if (f.type === "file" && f.file?.url) return { url: f.file.url, isExternal: false };
    }
  }
  return null;
}

// 확장자 → MIME 추측 (S3 가 빈 Content-Type 줄 때 fallback)
function guessMime(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map = {
    pdf: "application/pdf",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    hwp: "application/x-hwp",
    txt: "text/plain", md: "text/markdown",
    zip: "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

// RFC 5987: 한글 파일명 안전하게 헤더에 넣기
function encodeFilenameForHeader(name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_");
  const utf8 = encodeURIComponent(name);
  return `filename="${ascii.replace(/"/g, "")}"; filename*=UTF-8''${utf8}`;
}

// ── Normalize a row from 제작물 견적서 모음 ──────────────────────
function normalizeEstimate(page) {
  const p = page.properties || {};
  const rawName = readText(p["업체명"]);
  const note = readText(p["비고"]);
  return {
    id: page.id.replace(/-/g, ""),
    name: stripStatusEmoji(rawName) || "(이름 없음)",
    status: detectStatus(rawName, note),
    type: readMulti(p["구분"]),
    cat: readMulti(p["세부 카테고리"]),
    price: readNumber(p["숫자"]),
    duration: readText(p["소요 기간"]),
    leadDays: readNumber(p["납기일(일)"]),
    note,
    project: readTitle(p["제작물"]),
    url: page.url,
    // ▼ 노션 행 단위로 입력된 연락처/홈페이지 (per-row)
    rowPhone: readPhone(p["연락처"]),
    rowHomepage: readUrl(p["홈페이지"]),
    // ▼ 첨부 파일 (PDF/이미지/엑셀 등) — signed URL 은 ~1시간 후 만료
    files: readFiles(p["파일과 미디어"]),
    source: "estimates",
    lastEdited: page.last_edited_time,
  };
}

// ── Normalize a row from 구매 업체 ──────────────────────────────
function normalizeVendor(page) {
  const p = page.properties || {};
  const rawName = readTitle(p["이름"]) || readTitle(p["Name"]);
  const note = readText(p["비고"]);
  const tag = readSelect(p["선택"]);
  const fileProp = p["파일과 미디어"];
  let url = page.url;
  if (fileProp?.url) url = fileProp.url;
  else if (fileProp?.files?.[0]?.external?.url)
    url = fileProp.files[0].external.url;

  return {
    id: page.id.replace(/-/g, ""),
    name: stripStatusEmoji(rawName) || "(이름 없음)",
    status: detectStatus(rawName, note),
    type: ["제작"],
    cat: tag ? [tag === "지류" ? "인쇄물" : tag] : [],
    price: null,
    duration: "",
    leadDays: null,
    note,
    project: `구매 업체 (${tag || "기타"})`,
    url,
    source: "vendors",
    lastEdited: page.last_edited_time,
  };
}

// ── Query a Notion DB with full pagination ──────────────────────
async function queryAll(database_id) {
  const out = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id,
      start_cursor: cursor,
      page_size: 100,
    });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function loadContacts() {
  try {
    const raw = await fs.readFile(
      path.join(__dirname, "contacts.json"),
      "utf-8"
    );
    const json = JSON.parse(raw);
    return json.vendors || {};
  } catch {
    return {};
  }
}

// 같은 업체명의 여러 row 중 첫 번째 non-empty 값을 모음
function buildRowContactMap(vendors) {
  const map = {};
  for (const v of vendors) {
    if (!map[v.name]) map[v.name] = { phone: "", homepage: "" };
    if (!map[v.name].phone && v.rowPhone) map[v.name].phone = v.rowPhone;
    if (!map[v.name].homepage && v.rowHomepage) map[v.name].homepage = v.rowHomepage;
  }
  return map;
}

function attachContacts(vendors, contacts) {
  // 1) row 기반 매핑 (노션 견적서 row 가 source of truth — 노션이 우선)
  const rowMap = buildRowContactMap(vendors);

  return vendors.map((v) => {
    const fromJson = contacts[v.name] || {};
    const fromRow = rowMap[v.name] || {};
    // 노션 row 의 phone/homepage 가 contacts.json 보다 우선
    const merged = {
      phone:    fromRow.phone    || fromJson.phone    || "",
      homepage: fromRow.homepage || fromJson.homepage || "",
      email:    fromJson.email    || "",
      manager:  fromJson.manager  || "",
      memo:     fromJson.memo     || "",
    };
    // 모든 필드가 비어 있으면 null
    const hasAny = Object.values(merged).some((x) => x && x.length > 0);
    // rowPhone/rowHomepage 는 응답에서 제거 (내부용)
    const { rowPhone, rowHomepage, ...rest } = v;
    return { ...rest, contact: hasAny ? merged : null };
  });
}

async function fetchAllVendors() {
  if (!notion) throw new Error("NOTION_TOKEN not set");

  const [estimatesPages, vendorPages, contacts] = await Promise.all([
    queryAll(ESTIMATES_DB_ID).catch((e) => {
      console.error("[notion] estimates query failed:", e.message);
      return [];
    }),
    queryAll(VENDORS_DB_ID).catch((e) => {
      console.error("[notion] vendors query failed:", e.message);
      return [];
    }),
    loadContacts(),
  ]);

  const vendors = attachContacts(
    [
      ...estimatesPages.map(normalizeEstimate),
      ...vendorPages.map(normalizeVendor),
    ],
    contacts
  );

  return {
    generatedAt: new Date().toISOString(),
    source: "live",
    counts: { estimates: estimatesPages.length, vendors: vendorPages.length },
    vendors,
  };
}

async function getCachedVendors({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) return cache.data;
  const data = await fetchAllVendors();
  cache = { at: now, data };
  return data;
}

// ── HTTP server ─────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(req, res, filePath) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// ── /api/file 프록시: 노션 → 클라이언트 스트리밍 ─────────────────
async function handleFileProxy(req, res, url) {
  if (!notion) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
       .end("Notion 토큰이 설정되어 있지 않습니다 (.env 의 NOTION_TOKEN 확인)");
    return;
  }
  const pageId = url.searchParams.get("pageId");
  const fileName = url.searchParams.get("name");
  const action = url.searchParams.get("action") === "download" ? "download" : "view";
  if (!pageId || !fileName) {
    res.writeHead(400).end("pageId, name 쿼리 파라미터가 필요합니다");
    return;
  }
  try {
    const resolved = await resolveFileUrl(pageId, fileName);
    if (!resolved) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
         .end("해당 파일을 찾을 수 없습니다");
      return;
    }
    // 외부 URL(예: smartstore) 은 프록시할 의미가 적음 → 그냥 redirect
    if (resolved.isExternal) {
      res.writeHead(302, { Location: resolved.url }).end();
      return;
    }
    const upstream = await fetch(resolved.url);
    if (!upstream.ok || !upstream.body) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
         .end(`업스트림 응답 오류: ${upstream.status}`);
      return;
    }
    const upstreamType = upstream.headers.get("content-type") || guessMime(fileName);
    const contentLength = upstream.headers.get("content-length");
    const headers = {
      "Content-Type": upstreamType,
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": `${action === "download" ? "attachment" : "inline"}; ${encodeFilenameForHeader(fileName)}`,
    };
    if (contentLength) headers["Content-Length"] = contentLength;
    res.writeHead(200, headers);

    // Web stream → Node response 스트리밍
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    console.error("[/api/file]", e.message);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
       .end("파일 프록시 오류: " + e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/file") {
    return handleFileProxy(req, res, url);
  }

  if (url.pathname === "/api/vendors") {
    try {
      const force = url.searchParams.get("force") === "1";
      const data = await getCachedVendors({ force });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error("[/api/vendors]", e.message);
      // Fallback to snapshot
      try {
        const fallback = await fs.readFile(
          path.join(__dirname, "vendors.json"),
          "utf-8"
        );
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "X-Fallback": "snapshot",
        });
        res.end(fallback);
      } catch {
        res.writeHead(500).end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return serveStatic(req, res, path.join(__dirname, "vendor-finder-v2.html"));
  }

  if (url.pathname === "/vendors.json") {
    return serveStatic(req, res, path.join(__dirname, "vendors.json"));
  }

  if (url.pathname === "/vendor-finder-v2.html") {
    return serveStatic(req, res, path.join(__dirname, "vendor-finder-v2.html"));
  }

  res.writeHead(404).end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n  Vendor Finder running →  http://localhost:${PORT}`);
  console.log(
    `  Notion live sync:        ${notion ? "ON" : "OFF (NOTION_TOKEN missing — using snapshot)"}\n`
  );
});
