// Regenerates the vendored static assets in public/ from permissively licensed npm packages.
//   d3, topojson-client, world-atlas (ISC)  ·  i18n-iso-countries, country-to-currency (MIT)
//   Map geometry: Natural Earth (public domain) via world-atlas.
import { copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = (p) => new URL(`../node_modules/${p}`, import.meta.url);
const out = (p) => new URL(`../public/${p}`, import.meta.url);

copyFileSync(pkg("d3/dist/d3.min.js"), out("vendor/d3.min.js"));
copyFileSync(pkg("topojson-client/dist/topojson-client.min.js"), out("vendor/topojson-client.min.js"));
copyFileSync(pkg("world-atlas/countries-50m.json"), out("data/countries-50m.json"));
copyFileSync(pkg("world-atlas/countries-110m.json"), out("data/countries-110m.json"));

const countries = require("i18n-iso-countries");
const currencyByA2 = require("country-to-currency");
const ccy = currencyByA2.default ?? currencyByA2;

// numeric (as used by world-atlas feature ids) -> { a2, a3, name, currency }
const codes = {};
for (const [a2, numeric] of Object.entries(countries.getNumericCodes())) {
  // getNumericCodes returns numeric -> alpha2 in some versions; normalise both shapes
  const [num, alpha2] = /^\d+$/.test(a2) ? [a2, numeric] : [numeric, a2];
  codes[num] = { a2: alpha2, a3: countries.alpha2ToAlpha3(alpha2), currency: ccy[alpha2] ?? null };
}
writeFileSync(out("data/country-codes.json"), JSON.stringify(codes));

const notice = ["d3", "topojson-client", "world-atlas"]
  .map((p) => `==== ${p} ====\n` + readFileSync(pkg(`${p}/LICENSE`), "utf8").trim())
  .join("\n\n");
writeFileSync(out("vendor/THIRD_PARTY_LICENSES.txt"), notice + "\n");
console.log(`Wrote ${Object.keys(codes).length} country codes + vendored libraries.`);
