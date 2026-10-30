#!/usr/bin/env node
/**
 * 盯梢 2027 国考专题和陕西人事考试网。
 * 只记录官方标题和链接。不改职位库，不编造工资、报名人数、竞争比。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (compatible; PeGradCivilRadar/1.0; +https://git5018-xb.github.io/kaogong.html)";
const NOW = new Date();
const cst = new Date(NOW.getTime() + 8 * 3600 * 1000);
const stamp = cst.toISOString().replace("Z", "+08:00");
const HB = "8a81f6eca0221f1401a0242759fc0000";

function idOf(url, title) {
  return createHash("sha1").update(url + "|" + title).digest("hex").slice(0, 16);
}
async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}
function textOf(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
function absUrl(href, base) {
  try { return new URL(href, base).href.split("#")[0]; } catch { return href; }
}
function dayOf(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

async function scanGuokaoArticles() {
  const url = `http://dl.scs.gov.cn/api/gkhome/article/${HB}`;
  const data = JSON.parse(await fetchText(url));
  const hits = [];
  for (const group of data.articleGroupList || []) {
    if (!/招考公告/.test(group.title || "")) continue;
    for (const a of group.articleList || []) {
      const title = textOf(a.articleTitle);
      if (!title) continue;
      const link = a.articleUrl || `http://bm.scs.gov.cn/pp/gkweb/core/web/ui/business/article/articledetail.html?id=${a.id}`;
      hits.push({
        id: idOf(link, title),
        title,
        url: link,
        source: "国家公务员局2027国考专题",
        published: dayOf(a.pstrtime),
        kind: /结束|缴费|准考证|成绩|面试|体检|公示/.test(title) ? "考务进度" : "公告",
      });
    }
  }
  return { url: "http://bm.scs.gov.cn/kl2027", hits };
}

async function scanGuokaoFiles() {
  const url = `http://dl.scs.gov.cn/api/res/${HB}/1110`;
  const data = JSON.parse(await fetchText(url));
  const hits = [];
  for (const f of data.resList || []) {
    const title = decodeURIComponent(f.resourceName || "");
    if (!title) continue;
    const link = "http://bm.scs.gov.cn/pp/gkweb/core/web/ui/business/download/gkdownloads.html";
    hits.push({
      id: idOf(f.resResourceId || title, title),
      title: "官方下载：" + title,
      url: link,
      source: "国家公务员局2027国考专题",
      published: "",
      kind: "附件",
    });
  }
  return { url, hits };
}

function scanHtml(html, base, source, keep) {
  const hits = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const title = textOf(m[2]);
    if (!title || title.length < 8 || title.length > 80 || !keep.test(title)) continue;
    if (/收费|证书领取|复查|复核|药师|建造师|消防|造价/.test(title)) continue;
    const href = m[1].trim();
    if (href.startsWith("javascript:") || href === "#") continue;
    const url = absUrl(href, base);
    const key = url + "|" + title;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      id: idOf(url, title),
      title,
      url,
      source,
      published: "",
      kind: /公务员|省考|选调/.test(title) ? "省考或公务员" : "招考",
    });
  }
  return hits;
}

const SOURCES = [
  {
    id: "gk-articles",
    name: "国家公务员局2027国考公告",
    run: scanGuokaoArticles,
  },
  {
    id: "gk-files",
    name: "国家公务员局2027国考下载",
    run: scanGuokaoFiles,
  },
  {
    id: "sx",
    name: "陕西人事考试网",
    run: async () => {
      const home = "https://www.sxrsks.cn/website/home.aspx";
      const html = await fetchText(home);
      const sections = scanHtml(html, home, "陕西人事考试网", /统一考试录用公务员/);
      const portal = sections.find((h) => !/遴选|选调/.test(h.title));
      let more = [];
      if (portal) {
        const page = await fetchText(portal.url);
        more = scanHtml(page, portal.url, "陕西人事考试网", /公告|职位表|报名|准考证|成绩|面试|体检|录用|公示|指南|缴费/);
      }
      return { url: home, hits: [...sections, ...more].slice(0, 16) };
    },
  },
];

const prev = existsSync("kaogong-updates.json")
  ? JSON.parse(readFileSync("kaogong-updates.json", "utf8"))
  : { hits: [] };
const prevMap = new Map((prev.hits || []).map((h) => [h.id, h]));
const sources = [];
const hits = [];

for (const src of SOURCES) {
  const row = { id: src.id, name: src.name, url: "", ok: false, error: null, found: 0 };
  try {
    const got = await src.run();
    row.url = got.url;
    row.ok = true;
    row.found = got.hits.length;
    for (const h of got.hits) {
      const old = prevMap.get(h.id);
      hits.push({
        ...h,
        firstSeen: old?.firstSeen || stamp,
        isNew: !old,
      });
    }
  } catch (e) {
    row.error = e instanceof Error ? e.name === "AbortError" ? "超时" : e.message : String(e);
  }
  sources.push(row);
}

hits.sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)) || String(b.published).localeCompare(String(a.published)));

const out = {
  updatedAt: stamp,
  cadence: "北京时间大约每 2 小时检查一次。不是按秒刷新。",
  note: "只记录官网标题和链接。看到新公告不会自动写入职位库，也不会编造岗位、工资或报名人数。职位仍以 2026-10-30 入库的招考简章为准，直到有新的官方职位表。",
  sources,
  newCount: hits.filter((h) => h.isNew).length,
  hits: hits.slice(0, 40),
};

writeFileSync("kaogong-updates.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ updatedAt: stamp, sources, newCount: out.newCount, hitCount: out.hits.length }, null, 2));
