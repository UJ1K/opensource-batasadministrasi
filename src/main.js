import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import createGlobe from "cobe";
import "./style.css";

const tileUrl = import.meta.env.VITE_PMTILES_URL;
const subdistrictTileUrl = import.meta.env.VITE_SUBDISTRICT_PMTILES_URL;
const intro = document.querySelector("#globe-intro");
const introStatus = document.querySelector("#intro-status");
const introPhase = document.querySelector("#intro-phase");
const introCanvas = document.querySelector("#cobe-globe");
const introStarted = performance.now();
const spinDuration = 3900;
const focusDuration = 2100;
const introDuration = 8200;
const focusPhi = -(106.85 * Math.PI / 180) - Math.PI / 2;
const focusTheta = -6.2 * Math.PI / 180;

if (!tileUrl) {
  throw new Error("Missing VITE_PMTILES_URL. Copy .env.example to .env and set the PMTiles archive URL.");
}
let introFrame;
let globe;
let introClosed = false;
let indonesiaMarkerAdded = false;

if (intro && introCanvas) {
  document.body.classList.add("intro-playing");
  globe = createGlobe(introCanvas, {
    devicePixelRatio: 1.5,
    width: 720,
    height: 720,
    phi: 0,
    theta: 0.18,
    dark: 0,
    diffuse: 1.2,
    mapSamples: 16000,
    mapBrightness: 6,
    mapBaseBrightness: 0,
    baseColor: [0.92, 0.93, 0.91],
    markerColor: [0.72, 0.84, 0.62],
    glowColor: [0.75, 0.80, 0.73],
    markers: [],
    scale: 0.92,
    offset: [0, 0]
  });

  function animateIntro(now) {
    if (introClosed) return;
    const elapsed = now - introStarted;
    let phi;
    let theta = 0.18;
    if (elapsed < spinDuration) {
      phi = (elapsed / spinDuration) * Math.PI * 2;
      introStatus.textContent = introPhase.textContent = "ROTATING · PLANET EARTH";
    } else if (elapsed < spinDuration + focusDuration) {
      const progress = Math.min(1, (elapsed - spinDuration) / focusDuration);
      const eased = progress * progress * (3 - 2 * progress);
      phi = Math.PI * 2 + (focusPhi - Math.PI * 2) * eased;
      theta = 0.18 + (focusTheta - 0.18) * eased;
      introStatus.textContent = introPhase.textContent = "LOCKING ON · INDONESIA";
      if (progress > 0.72) {
        intro.classList.add("is-focused");
        if (!indonesiaMarkerAdded) {
          indonesiaMarkerAdded = true;
          globe.update({ markers: [{ location: [-6.2, 106.85], size: 0.055, color: [0.98, 0.45, 0.18], id: "indonesia" }] });
        }
      }
    } else {
      phi = focusPhi;
      theta = focusTheta;
      introStatus.textContent = introPhase.textContent = "INDONESIA · 6° 12′ S, 106° 50′ E";
      intro.classList.add("is-focused");
    }
    globe.update({ phi, theta });
    const progress = Math.min(100, elapsed / introDuration * 100);
    intro.style.setProperty("--intro-progress", `${progress}%`);
    if (elapsed >= introDuration) closeIntro();
    else introFrame = requestAnimationFrame(animateIntro);
  }

  function closeIntro() {
    if (introClosed) return;
    introClosed = true;
    cancelAnimationFrame(introFrame);
    intro.classList.add("is-leaving");
    window.setTimeout(() => {
      globe?.destroy();
      intro.remove();
      document.body.classList.remove("intro-playing");
    }, 750);
  }

  document.querySelector("#intro-skip")?.addEventListener("click", closeIntro);
  introFrame = requestAnimationFrame(animateIntro);
} else {
  intro?.remove();
}
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const app = document.querySelector("#app");
const map = new maplibregl.Map({
  container: "map",
  center: [118, -2.2],
  zoom: 2.5,
  minZoom: 1,
  maxZoom: 18,
  maxBounds: [[90, -18], [146, 15]],
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Tiles © Esri, Maxar, Earthstar Geographics, and the GIS User Community"
      },
      admin: { type: "vector", url: `pmtiles://${tileUrl}`, attribution: "Indonesia provincial boundaries" },
      ...(subdistrictTileUrl ? { subdistrict: { type: "vector", url: `pmtiles://${subdistrictTileUrl}`, attribution: "Indonesia subdistrict boundaries" } } : {})
    },
    layers: [{ id: "basemap", type: "raster", source: "osm", paint: { "raster-opacity": 1 } }]
  }
});

const mapResizeObserver = new ResizeObserver(() => map.resize());
mapResizeObserver.observe(map.getContainer());

const exportButton = document.querySelector("#export-selected");
const cancelExportButton = document.querySelector("#cancel-export");
const exportProgress = document.querySelector("#export-progress");
const exportStatus = document.querySelector("#export-status");
const featureCard = document.querySelector("#feature-card");
const themeButtons = [...document.querySelectorAll("[data-theme]")];
const boundaryInputs = [...document.querySelectorAll('input[name="boundary-level"]')];
const featureLayersByLevel = { province: [], subdistrict: [] };
const allFeatureLayers = [];
let latestFeature = null;
let theme = "light";
let activeBoundary = "province";
const archiveBySource = {};
let exportAbortController;

function titleCase(value) { return String(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

function addArchiveLayers(level, sourceId, vectorLayers) {
  for (const layer of vectorLayers) {
    const sourceLayer = layer.id || layer.name;
    if (!sourceLayer) continue;
    const layerId = `admin-${level}-${sourceLayer}`;
    map.addLayer({
      id: layerId,
      source: sourceId,
      "source-layer": sourceLayer,
      type: "fill",
      layout: { visibility: activeBoundary === level ? "visible" : "none" },
      paint: {
        "fill-color": theme === "light" ? "#bfcfb9" : "#70918b",
        "fill-opacity": 0.58,
        "fill-outline-color": theme === "light" ? "#637565" : "#d4a06f"
      }
    });
    featureLayersByLevel[level].push(layerId);
    allFeatureLayers.push(layerId);
    const lineId = `${layerId}-line`;
    map.addLayer({
      id: lineId,
      source: sourceId,
      "source-layer": sourceLayer,
      type: "line",
      layout: { visibility: activeBoundary === level ? "visible" : "none" },
      paint: { "line-color": theme === "light" ? "#637565" : "#d4a06f", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.45, 8, 1.15] }
    });
    featureLayersByLevel[level].push(lineId);
    allFeatureLayers.push(lineId);
  }
}

async function initializeArchive(level, sourceId, url) {
  const radio = document.querySelector(`#${level === "province" ? "layer-toggle" : "subdistrict-toggle"}`);
  if (!url) {
    if (radio) radio.disabled = true;
    return;
  }
  try {
    const archive = protocol.get(url);
    const [header, metadata] = await Promise.all([archive.getHeader(), archive.getMetadata()]);
    const vectorLayers = Array.isArray(metadata.vector_layers) ? metadata.vector_layers : [];
    archiveBySource[sourceId] = archive;
    addArchiveLayers(level, sourceId, vectorLayers);
    if (radio) radio.disabled = vectorLayers.length === 0;
    if (level === "province" && header.minLon != null && header.minLat != null && header.maxLon != null && header.maxLat != null) {
      map.fitBounds([[header.minLon, header.minLat], [header.maxLon, header.maxLat]], { padding: 36, maxZoom: 4.5, duration: 0 });
    }
    if (radio && !vectorLayers.length) radio.title = "This archive has no vector layers.";
  } catch (error) {
    console.error(`Unable to load ${level} PMTiles archive:`, error);
    if (radio) {
      radio.disabled = true;
      radio.title = "Archive unavailable. Check the PMTiles URL, byte-range access, and CORS.";
    }
  }
}

map.on("load", async () => {
  await Promise.all([
    initializeArchive("province", "admin", tileUrl),
    initializeArchive("subdistrict", "subdistrict", subdistrictTileUrl)
  ]);
});

exportButton.addEventListener("click", async () => {
  if (!latestFeature) return;
  exportAbortController = new AbortController();
  exportButton.disabled = true;
  cancelExportButton.hidden = false;
  exportProgress.hidden = false;
  exportProgress.value = 0;
  exportProgress.max = 1;
  try {
    const { createProvinceShapefile } = await import("./province-export.js");
    const archive = archiveBySource[latestFeature.source];
    if (!archive) throw new Error("The selected boundary archive is unavailable.");
    const sourceLayer = latestFeature.sourceLayer || latestFeature.layer?.['source-layer'];
    if (!sourceLayer) throw new Error("Could not identify the selected feature's source layer.");
    const result = await createProvinceShapefile(archive, sourceLayer, latestFeature, {
      signal: exportAbortController.signal,
      onProgress: ({ stage, completed, total, count }) => {
        exportStatus.textContent = count
          ? `Preparing ${count} polygon records…`
          : `${stage} · ${completed} of ${total}`;
        exportProgress.max = Math.max(total, 1);
        exportProgress.value = completed;
      }
    });
    const objectUrl = URL.createObjectURL(result.blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${result.fileName}.zip`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    exportStatus.textContent = `Downloaded ${result.name} as a Shapefile ZIP (WGS 84).`;
  } catch (error) {
    if (error.name === "AbortError") exportStatus.textContent = "Export cancelled.";
    else {
      console.error("Unable to export province Shapefile:", error);
      exportStatus.textContent = error.message || "Export failed. Check the archive layer and storage access.";
    }
  } finally {
    exportAbortController = undefined;
    exportButton.disabled = !latestFeature;
    cancelExportButton.hidden = true;
    exportProgress.hidden = true;
  }
});

cancelExportButton.addEventListener("click", () => exportAbortController?.abort());

map.on("error", (event) => {
  if (event?.sourceId === "admin" || event?.sourceId === "subdistrict") console.error(`${event.sourceId} tile request failed:`, event.error || event);
});

map.on("click", (event) => {
  const fillLayers = featureLayersByLevel[activeBoundary].filter((id) => map.getLayer(id) && !id.endsWith("-line"));
  if (!fillLayers.length) return;
  const feature = map.queryRenderedFeatures(event.point, { layers: fillLayers })[0];
  if (!feature) { featureCard.hidden = true; latestFeature = null; exportButton.disabled = true; return; }
  latestFeature = feature;
  exportButton.disabled = false;
  exportStatus.textContent = "";
  const props = feature.properties || {};
  const entries = Object.entries(props).filter(([, value]) => value != null && String(value).length < 220).slice(0, 12);
  const title = activeBoundary === "subdistrict"
    ? props.WADMKC || props.KECAMATAN || props.NAMOBJ || props.NAME_3 || props.name_3 || props.name || props.NAME_2 || "Subdistrict area"
    : props.NAME_1 || props.name || props.NAME || props.name_en || props.admin || props.shapeName || "Administrative area";
  document.querySelector("#feature-title").textContent = title;
  document.querySelector("#feature-properties").innerHTML = entries.length
    ? entries.map(([key, value]) => `<div class="property-row"><span>${escapeHtml(titleCase(key))}</span><b>${escapeHtml(String(value))}</b></div>`).join("")
    : `<p class="no-properties">This feature has no additional attributes.</p>`;
  featureCard.hidden = false;
});

function escapeHtml(value) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

map.on("mousemove", (event) => {
  const hasFeature = featureLayersByLevel[activeBoundary].some((id) => map.getLayer(id) && !id.endsWith("-line") && map.queryRenderedFeatures(event.point, { layers: [id] }).length);
  map.getCanvas().style.cursor = hasFeature ? "pointer" : "grab";
});

boundaryInputs.forEach((input) => input.addEventListener("change", () => {
  if (!input.checked) return;
  activeBoundary = input.value;
  for (const [level, ids] of Object.entries(featureLayersByLevel)) {
    for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", level === activeBoundary ? "visible" : "none");
  }
  featureCard.hidden = true;
  latestFeature = null;
  exportButton.disabled = true;
}));

document.querySelector("#zoom-in").addEventListener("click", () => map.zoomIn());
document.querySelector("#zoom-out").addEventListener("click", () => map.zoomOut());
document.querySelector("#reset-view").addEventListener("click", () => map.flyTo({ center: [118, -2.2], zoom: 2.5, duration: 900 }));
document.querySelector("#feature-close").addEventListener("click", () => { featureCard.hidden = true; latestFeature = null; exportButton.disabled = true; });

themeButtons.forEach((button) => button.addEventListener("click", () => {
  theme = button.dataset.theme;
  themeButtons.forEach((candidate) => candidate.classList.toggle("active", candidate === button));
  const dark = theme === "dark";
  map.setPaintProperty("basemap", "raster-opacity", dark ? 0.85 : 1);
  for (const id of allFeatureLayers) {
    if (map.getLayer(id) && !id.endsWith("-line")) {
      map.setPaintProperty(id, "fill-color", dark ? "#70918b" : "#bfcfb9");
      map.setPaintProperty(id, "fill-outline-color", dark ? "#d4a06f" : "#637565");
    } else if (map.getLayer(id)) map.setPaintProperty(id, "line-color", dark ? "#d4a06f" : "#637565");
  }
}));


























