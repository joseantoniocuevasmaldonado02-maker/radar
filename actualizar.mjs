// Actualiza data/data.json desde fuentes públicas. Se ejecuta en GitHub Actions.
// Si una fuente no se puede leer o no se entiende, conserva el dato anterior.
import { readFile, writeFile } from "node:fs/promises";

const FILE = "data/data.json";
const UA = "Mozilla/5.0 (RadarPortafolio; +https://github.com)";
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const num = s => parseFloat(String(s).replace(",", "."));
const ok = v => Number.isFinite(v) && v > 30 && v < 150;

async function get(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xml,*/*" }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}
const strip = h => h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<!\[CDATA\[|\]\]>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// ---------- Inflación (BCRD, vía notas publicadas) ----------
// Busca notas recientes sobre el IPC y extrae mes, variación mensual e interanual.
// Heurística: revisar siempre el resultado contra bancentral.gov.do.
const INF_FEEDS = [
  "https://despertarmatinal.com/feed/",
  "https://eldinero.com.do/feed/",
  "https://www.elcaribe.com.do/feed/",
  "https://acento.com.do/feed/"
];
async function leerInflacion(actual) {
  const hallazgos = [];
  for (const f of INF_FEEDS) {
    const xml = await get(f);
    if (!xml) continue;
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 25).map(m => m[1]);
    for (const it of items) {
      const title = strip((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
      const desc = strip((it.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/) || it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "");
      const texto = title + ". " + desc;
      if (!/IPC|inflaci[oó]n/i.test(texto) || !/Banco Central|BCRD/i.test(texto)) continue;
      const mm = texto.match(/variaci[oó]n mensual[^%]{0,60}?(\d+[.,]\d{1,2})\s*%/i);
      const iy = texto.match(/interanual[^%]{0,90}?(\d+[.,]\d{1,2})\s*%/i);
      if (!mm) continue;
      // mes: el que aparece en la misma frase que "variación mensual"
      const cerca = texto.slice(Math.max(0, texto.search(/variaci[oó]n mensual/i) - 120), texto.search(/variaci[oó]n mensual/i) + 120);
      const mes = [...cerca.matchAll(new RegExp("\\b(" + MESES.join("|") + ")\\b", "gi"))].map(x => x[1].toLowerCase()).pop();
      const pub = Date.parse((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]) || 0;
      if (!mes) continue;
      hallazgos.push({ mes: MESES.indexOf(mes) + 1, mensual: num(mm[1]), interanual: iy ? num(iy[1]) : null, pub });
    }
  }
  if (!hallazgos.length) return actual;
  // Para cada mes, toma la nota más reciente y solo acepta valores plausibles.
  const best = {};
  hallazgos.sort((a, b) => b.pub - a.pub).forEach(h => {
    if (h.mes && !best[h.mes] && h.mensual > -2 && h.mensual < 3 && (h.interanual === null || ok(h.interanual))) best[h.mes] = h;
  });
  const months = new Map(actual.months.map(r => [r[0], r]));
  Object.values(best).forEach(h => {
    const prev = months.get(h.mes);
    months.set(h.mes, [h.mes, h.mensual, h.interanual ?? (prev ? prev[2] : null)]);
  });
  return { year: 2026, months: [...months.values()].sort((a, b) => a[0] - b[0]) };
}

// ---------- Combustibles (MICM) ----------
const FUEL = [["Gasolina Premium","Gasolina\\s+Premium"],["Gasolina Regular","Gasolina\\s+Regular"],["Gasoil Regular","Gasoil\\s+Regular"],["Gasoil Óptimo","Gasoil\\s+[ÓóOo]ptimo"],["Avtur","Avtur"],["Kerosene","Kerosene"],["Fuel Oíl #6","Fuel\\s+O[ií]l\\s+#?\\s*6"],["Fuel Oíl 1%S","Fuel\\s+O[ií]l\\s+1\\s*%"],["GLP (gas licuado)","Gas\\s+Licuado"],["Gas Natural","Gas\\s+Natural"]];
function parseFuel(t) {
  const i = t.search(/siguientes precios/i), s = i >= 0 ? t.slice(i) : t, out = [];
  FUEL.forEach(([n, re]) => {
    const m = s.match(new RegExp(re + ".{0,40}?RD\\$\\s*([\\d,.]+?)\\s*por\\s+(gal[oó]n|m3|m³)\\s+(sube|baja|mantiene)(?:\\s{0,3}RD\\$\\s*([\\d,.]+))?", "i"));
    if (m) { const p = num(m[1].replace(/,/g, "")); if (p > 5 && p < 2000) out.push({ n, p, u: /gal/i.test(m[2]) ? "galón" : "m³", k: m[3].toLowerCase(), d: m[4] ? num(m[4].replace(/,/g, "")) : 0 }); }
  });
  const w = (t.match(/semana del\s+(\d{1,2}\s+al\s+\d{1,2}\s+de\s+[a-záéíóú]+(?:\s+de\s+\d{4})?)/i) || [])[1];
  return { out, w };
}
async function leerCombustibles(actual) {
  const candidatos = ["https://micm.gob.do/tag/noticia/feed/", "https://micm.gob.do/feed/", "https://micm.gob.do/tag/combustibles/feed/"];
  let mejor = null;
  for (const f of candidatos) {
    const xml = await get(f);
    if (!xml) continue;
    for (const it of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map(m => m[1])) {
      const body = strip(it);
      const r = parseFuel(body);
      const pub = Date.parse((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]) || 0;
      const link = ((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "").trim();
      if (r.out.length >= 4 && (!mejor || pub > mejor.t)) mejor = { w: r.w, t: pub, link, out: r.out };
    }
    if (mejor) break;
  }
  return mejor || actual;
}

// ---------- Principal ----------
const actual = JSON.parse(await readFile(FILE, "utf8"));
const [fuel, inflation] = await Promise.all([leerCombustibles(actual.fuel), leerInflacion(actual.inflation)]);
const salida = { updated: new Date().toISOString(), fuel, inflation };
await writeFile(FILE, JSON.stringify(salida, null, 2) + "\n", "utf8");
console.log("Combustibles:", fuel === actual.fuel ? "sin cambios" : "actualizados", "| Inflación meses:", inflation.months.length);
