# Planet Pulse

A live dashboard of Earth, built only on **public-domain and permissively licensed open data**. Every source here allows commercial use. Nothing is copyleft or share-alike.

- 🌍 **Interactive 3D globe or flat map.** Drag to spin, scroll or pinch to zoom, with live day/night shading.
- 🌋 **Earthquakes** from USGS. Choose the feed: M2.5+ for the past day, M4.5+ for the past week, significant quakes for the past month, and more. Quakes from the last hour pulse on the map.
- 🔥 **Natural events** from NASA EONET: wildfires, storms, volcanoes, sea ice and more. Each category has its own glyph, and you can toggle categories on and off.
- 🧲 **Geomagnetic Kp index** from NOAA SWPC, with storm levels and an aurora outlook.
- 🏳️ **Country panel.** Click a country to see World Bank indicators (population, GDP, life expectancy, internet use, renewables), its local quakes and events, and its live exchange rate.
- 💱 **Currency converter** using European Central Bank reference rates (via Frankfurter).
- 🔄 **Auto-refresh.** Live feeds update every 5 minutes, and FX rates update every hour.

No backend, no API keys, no build step. It's a static site that calls free public APIs from the browser.

## Run locally

```bash
npm start
```

Then open http://localhost:8080. Any static file server pointed at `public/` also works, for example `python3 -m http.server -d public 8080`.

## Deploy

Upload the `public/` folder to any static host, such as GitHub Pages, Netlify, Cloudflare Pages, Vercel or S3.

## Data sources & licenses

| Source | Used for | License | Commercial use |
|---|---|---|---|
| [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) | Earthquakes | Public domain (US Government work) | ✅ |
| [NASA EONET v3](https://eonet.gsfc.nasa.gov/docs/v3) | Natural events | Public domain (NASA) | ✅ |
| [NOAA SWPC](https://services.swpc.noaa.gov/) | Kp index | Public domain (US Government work) | ✅ |
| [World Bank Indicators API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392) | Country indicators | **CC BY 4.0** (attribution required) | ✅ |
| [ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/) via [Frankfurter](https://frankfurter.dev/) | Exchange rates | ECB: free reuse with source credit · Frankfurter: MIT | ✅ |
| [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) via [world-atlas](https://github.com/topojson/world-atlas) | Country shapes | Public domain · ISC | ✅ |
| [D3](https://d3js.org/), [topojson-client](https://github.com/topojson/topojson-client) | Rendering | ISC | ✅ |
| [i18n-iso-countries](https://github.com/michaelwittig/node-i18n-iso-countries), [country-to-currency](https://github.com/thiagodp/country-to-currency) | Country and currency codes (build time) | MIT | ✅ |

**Your obligations:** keep the attribution footer and the "Sources & licenses" dialog. World Bank (CC BY 4.0) and the ECB require source credit, and the ISC and MIT notices are in `public/vendor/THIRD_PARTY_LICENSES.txt`. The public-domain US-government sources ask that you don't imply endorsement.

Data sources I deliberately avoided: OpenStreetMap (ODbL is share-alike), REST Countries (MPL-2.0 is weak copyleft), and the free tier of Open-Meteo (non-commercial only).

## Updating the bundled static data

The map shapes, country codes and libraries are vendored into `public/`. To refresh them:

```bash
npm install && npm run build:data
```

## Project layout

```
public/
  index.html          markup
  css/styles.css      styling (dark, glassy, responsive)
  js/app.js           map rendering, API calls, UI
  data/               Natural Earth TopoJSON + country/currency codes
  vendor/             d3, topojson-client, license notices
scripts/build-data.mjs  regenerates public/data and public/vendor
```

> Information only. Do not use it for safety-critical decisions.
