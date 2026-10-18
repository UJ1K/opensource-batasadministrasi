const INDONESIA_BOUNDS = { minLon: 90, minLat: -18, maxLon: 146, maxLat: 15 };
const MAX_EXPORT_TILES = 1500;
const PROVINCE_NAME_FIELDS = [
  "province", "provinsi", "province_name", "provinsi_name", "nama_provinsi",
  "namaprov", "prov_name", "name_1", "nama_prov", "wadmpr", "prov", "name"
];

export async function createProvinceShapefile(archive, layerId, selectedFeature, { signal, onProgress } = {}) {
  const [{ VectorTile }, { PbfReader }, { zip: writeShapefileZip }, { unzipSync, zipSync, strToU8 }] = await Promise.all([
    import("@mapbox/vector-tile"),
    import("pbf"),
    import("@mapbox/shp-write"),
    import("fflate")
  ]);

  const [header, metadata] = await Promise.all([archive.getHeader(), archive.getMetadata()]);
  const sourceLayer = (metadata.vector_layers || []).find((layer) => layer.id === layerId);
  if (!sourceLayer) throw new Error("Choose a vector layer from this archive first.");

  const bounds = {
    minLon: Math.max(header.minLon, INDONESIA_BOUNDS.minLon),
    minLat: Math.max(header.minLat, INDONESIA_BOUNDS.minLat),
    maxLon: Math.min(header.maxLon, INDONESIA_BOUNDS.maxLon),
    maxLat: Math.min(header.maxLat, INDONESIA_BOUNDS.maxLat)
  };
  if (bounds.minLon >= bounds.maxLon || bounds.minLat >= bounds.maxLat) {
    throw new Error("This archive has no tile coverage inside Indonesia.");
  }

  const minZoom = Math.max(header.minZoom, Number(sourceLayer.minzoom ?? header.minZoom));
  const maxZoom = Math.min(header.maxZoom, Number(sourceLayer.maxzoom ?? header.maxZoom));
  if (minZoom > maxZoom) throw new Error("The selected layer has no available zoom levels.");
  const zoom = Math.max(minZoom, Math.min(6, maxZoom));
  const scale = 2 ** zoom;
  const tileX = (longitude) => Math.max(0, Math.min(scale - 1, Math.floor((longitude + 180) / 360 * scale)));
  const tileY = (latitude) => {
    const radians = latitude * Math.PI / 180;
    const mercatorY = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
    return Math.max(0, Math.min(scale - 1, Math.floor(mercatorY * scale)));
  };
  const minX = tileX(bounds.minLon);
  const maxX = tileX(bounds.maxLon);
  const minY = tileY(bounds.maxLat);
  const maxY = tileY(bounds.minLat);
  const tiles = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) tiles.push({ x, y });
  }
  if (tiles.length > MAX_EXPORT_TILES) {
    throw new Error(`This layer needs ${tiles.length.toLocaleString()} tiles at zoom ${zoom}; the in-browser export limit is ${MAX_EXPORT_TILES.toLocaleString()}.`);
  }

  const nameField = findProvinceNameField(sourceLayer.fields || {});
  const groups = new Map();
  let completed = 0;
  onProgress?.({ stage: "Reading tiles", completed, total: tiles.length });

  let nextIndex = 0;
  async function readTiles() {
    while (nextIndex < tiles.length) {
      if (signal?.aborted) throw new DOMException("Export cancelled.", "AbortError");
      const tile = tiles[nextIndex++];
      const response = await archive.getZxy(zoom, tile.x, tile.y, signal);
      if (response?.data) {
        const vectorTile = new VectorTile(new PbfReader(response.data));
        const layer = vectorTile.layers[layerId];
        if (layer) {
          for (let index = 0; index < layer.length; index += 1) {
            const vectorFeature = layer.feature(index);
            if (vectorFeature.type !== 3) continue;
            const feature = vectorFeature.toGeoJSON(tile.x, tile.y, zoom);
            if (!feature.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) continue;
            if (!matchesSelectedFeature(feature, selectedFeature)) continue;
            const key = provinceGroupKey(feature, nameField);
            let group = groups.get(key);
            if (!group) {
              group = { properties: { ...feature.properties }, geometries: [] };
              groups.set(key, group);
            } else {
              mergeSharedProperties(group.properties, feature.properties);
            }
            group.geometries.push(feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates);
          }
        }
      }
      completed += 1;
      onProgress?.({ stage: "Reading tiles", completed, total: tiles.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, tiles.length) }, () => readTiles()));
  if (!groups.size) throw new Error("No matching polygon tiles were found for the selected area.");

  const features = [];
  for (const group of groups.values()) {
    if (signal?.aborted) throw new DOMException("Export cancelled.", "AbortError");
    const polygons = group.geometries.flatMap((geometry) => geometry);
    if (polygons.length) features.push({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: polygons }, properties: group.properties });
  }
  if (!features.length) throw new Error("No province polygons could be assembled from the selected layer.");

  const properties = normalizeProperties(features);
  const collection = {
    type: "FeatureCollection",
    features: features.map((feature) => ({ ...feature, properties: properties(feature.properties) }))
  };
  onProgress?.({ stage: "Creating Shapefile ZIP", completed: 0, total: 1 });
  const shpZip = await writeShapefileZip(collection, {
    folder: "indonesia_provinces",
    outputType: "uint8array",
    compression: "STORE",
    types: { polygon: "indonesia_provinces" },
    prj: 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]'
  });
  const files = unzipSync(shpZip);
  const shpPath = Object.keys(files).find((path) => path.toLowerCase().endsWith(".shp"));
  if (!shpPath) throw new Error("The Shapefile writer did not create a .shp file.");
  files[shpPath.replace(/\.shp$/i, ".cpg")] = strToU8("UTF-8\n");
  const zipBytes = zipSync(files, { level: 0 });
  const name = getFeatureName(selectedFeature?.properties || features[0].properties);
  const fileName = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "selected_area";
  onProgress?.({ stage: "Ready", completed: 1, total: 1, count: features.length });
  return { blob: new Blob([zipBytes], { type: "application/zip" }), count: features.length, zoom, name, fileName };
}

function matchesSelectedFeature(candidate, selected) {
  if (!selected) return false;
  const target = selected.properties || {};
  const entries = Object.entries(target).filter(([, value]) => value != null && ["string", "number", "boolean"].includes(typeof value));
  if (!entries.length && selected.id != null) return String(candidate.id) === String(selected.id);
  return entries.length > 0 && entries.every(([key, value]) => String(candidate.properties?.[key] ?? "") === String(value));
}

function getFeatureName(properties) {
  const entry = Object.entries(properties).find(([key, value]) => /^(name|name_1|nama|nama_prov|namobj|shapeName|admin)$/i.test(key) && value != null && String(value).trim());
  return entry ? String(entry[1]).trim() : "selected_area";
}

function findProvinceNameField(fields) {
  const byNormalizedName = new Map(Object.keys(fields).map((field) => [normalizeKey(field), field]));
  for (const candidate of PROVINCE_NAME_FIELDS) {
    const found = byNormalizedName.get(normalizeKey(candidate));
    if (found) return found;
  }
  return null;
}

function provinceGroupKey(feature, nameField) {
  const value = nameField ? feature.properties?.[nameField] : null;
  if (value != null && String(value).trim()) return `province:${String(value).trim().toLocaleLowerCase()}`;
  if (feature.id != null) return `id:${feature.id}`;
  return `feature:${Object.entries(feature.properties || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value}`).join("|")}`;
}

function mergeSharedProperties(target, incoming = {}) {
  for (const key of Object.keys(target)) {
    if (target[key] !== incoming[key]) target[key] = "";
  }
}

function normalizeProperties(features) {
  const fields = [...new Set(features.flatMap((feature) => Object.keys(feature.properties || {})))];
  const names = new Map();
  for (const field of fields) {
    const base = field.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 10) || "FIELD";
    let name = base;
    let suffix = 1;
    while ([...names.values()].includes(name.toLowerCase())) {
      const tail = String(suffix++);
      name = `${base.slice(0, 10 - tail.length)}${tail}`;
    }
    names.set(field, name.toLowerCase());
  }
  return (source = {}) => Object.fromEntries(fields.map((field) => [names.get(field), toDbfValue(source[field])]));
}

function toDbfValue(value) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 254 ? `${text.slice(0, 251)}...` : text;
}

function normalizeKey(value) { return String(value).toLowerCase().replace(/[^a-z0-9]/g, ""); }
