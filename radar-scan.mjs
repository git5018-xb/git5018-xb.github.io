#!/usr/bin/env node
/**
 * 定时盯梢：拉取西安官方招考页，提取招聘公告标题。
 * 不编造工资、报名人数、事业编。标题含「体育」才标 peMention。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (compatible; XianPeTeacherRadar/1.0; +https://git5018-xb.github.io/radar.html)";
const NOW = new Date();
const cst = new Date(NOW.getTime() + 8 * 3600 * 1000);
const stamp = cst.toISOString().replace("Z", "+08:00");

const SOURCES = [
  { id: "xa-exam", name: "西安市人民政府招考信息", url: "https://www.xa.gov.cn/gk/rsxx/gwykl/1.html" },
  { id: "xa-h2", name: "2026下半年市事业单位招聘公告页", url: "https://www.xa.gov.cn/gk/rsxx/gwykl/2094612371989401601.html" },
  { id: "gaoxin", name: "西安高新区通知公告", url: "https://xdz.xa.gov.cn/xwzx/tzgg/1.html" },
  { id: "edu", name: "西安市教育局", url: "https://edu.xa.gov.cn/" },
  { id: "szeb", name: "深圳市教育局公办学校招聘", url: "https://szeb.sz.gov.cn/home/xxgk/zthd/jszp/gbxx/" },
  { id: "yuexiu", name: "广州市越秀区招考", url: "http://www.yuexiu.gov.cn/zwgk/rsxx/gkzkzp/zpgg/" },
  { id: "zhuhai", name: "珠海市公职招考", url: "https://www.zhuhai.gov.cn/zw/rsxx/gzzk/" },
  { id: "fuzhou", name: "福州市政府通知公告", url: "https://www.fuzhou.gov.cn/zwgk/tzgg/" },
];

const KEEP = /公开招聘|教师招聘|教职工|体育教师|特岗|人才引进|事业单位公开招聘|公开招聘工作人员/;
const DROP = /收费|诊所|放射|注销备案|征求意见|商业航天/;
const NAV = /^(招考信息|招聘求职|通知公告|行政事业性收费|公共企事业单位)$/;

function absUrl(href, base) {
  try { return new URL(href, base).href; } catch { return href; }
}
function strip(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
}
function textOf(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&/g, "&")
    .replace(/</g, "<").replace(/>/g, ">").replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}
function idOf(url, title) {
  return createHash("sha1").update(url + "|" + title).digest("hex").slice(0, 16);
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function extract(html, base) {
  const hits = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html))) {
    const title = textOf(m[2]);
    const href = m[1].trim();
    if (!title || title.length < 10 || NAV.test(title) || DROP.test(title) || !KEEP.test(title)) continue;
    if (href.startsWith("javascript:") || href === "#") continue;
    const url = absUrl(href, base).split("#")[0];
    if (url === base || url.replace(/\/$/, "") === base.replace(/\/$/, "")) continue;
    const key = url + "|" + title;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      id: idOf(url, title),
      title,
      url,
      peMention: /体育/.test(title),
      kind: /公示|拟聘/.test(title) ? "公示" : /公告|招聘/.test(title) ? "招聘公告" : "其他",
    });
  }
  return hits;
}

const prev = existsSync("radar-updates.json") ? JSON.parse(readFileSync("radar-updates.json", "utf8")) : { hits: [] };
const prevIds = new Set((prev.hits || []).map((h) => h.id));

const sources = [];
let hits = [...(prev.hits || [])];

for (const src of SOURCES) {
  const row = { id: src.id, name: src.name, url: src.url, ok: false, error: null, found: 0 };
  try {
    const html = strip(await fetchText(src.url));
    const found = extract(html, src.url).map((h) => ({
      ...h,
      source: src.name,
      foundAt: prevIds.has(h.id) ? (prev.hits.find((x) => x.id === h.id)?.foundAt || stamp) : stamp,
      new: !prevIds.has(h.id),
    }));
    row.ok = true;
    row.found = found.length;
    for (const h of found) {
      const i = hits.findIndex((x) => x.id === h.id);
      if (i >= 0) hits[i] = { ...hits[i], ...h, new: hits[i].new || h.new };
      else hits.push(h);
    }
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  }
  sources.push(row);
}

hits.sort((a, b) => String(b.foundAt).localeCompare(String(a.foundAt)));
if (hits.length > 80) hits = hits.slice(0, 80);

const out = {
  updatedAt: stamp,
  cadence: "每个工作时段约 2 小时检查一次官方网站（不是按秒刷新）",
  note: "只收录官方页面上的招聘/招考标题。没有岗位表时不会编造体育教师岗位，也不会自行标事业编。",
  sources,
  peNew: hits.filter((h) => h.peMention && h.new).length,
  newCount: hits.filter((h) => h.new).length,
  hits,
};

writeFileSync("radar-updates.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ updatedAt: stamp, sources: sources.map((s) => [s.id, s.ok, s.found, s.error]), peNew: out.peNew, newCount: out.newCount, total: hits.length }, null, 2));
