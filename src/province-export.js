const INDONESIA_BOUNDS = { minLon: 90, minLat: -18, maxLon: 146, maxLat: 15 };
const MAX_EXPORT_TILES = 12000;
const MAX_CANDIDATE_TILES = 250000;
const PROVINCE_NAME_FIELDS = [
  "province", "provinsi", "province_name", "provinsi_name", "nama_provinsi",
  "namaprov", "prov_name", "name_1", "nama_prov", "wadmpr", "prov", "name"
];

export async function createProvinceShapefile(archive, layerId, selectedFeatures, { signal, onProgress } = {}) {
  if (!Array.isArray(selectedFeatures)) selectedFeatures = [selectedFeatures];
  if (!selectedFeatures.length) throw new Error("Select at least one area to export.");
  const [{ VectorTile }, { PbfReader }, { default: polygonClipping }, { zipSync, strToU8 }] = await Promise.all([
    import("@mapbox/vector-tile"),
    import("pbf"),
    import("polygon-clipping"),
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
  const zoom = maxZoom;
  const tiles = await findFeatureTiles(archive, selectedFeatures, layerId, minZoom, zoom, bounds, { signal, onProgress });
  if (!tiles.length) throw new Error("No source tiles were found for the selected area at the archive's highest detail zoom.");
  if (tiles.length > MAX_EXPORT_TILES) {
    throw new Error(`The selected area needs ${tiles.length.toLocaleString()} source tiles at zoom ${zoom}, above this browser export's ${MAX_EXPORT_TILES.toLocaleString()} tile limit. The archive's full detail can't be safely assembled in this browser.`);
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
      const response = tile.data ? { data: tile.data } : await archive.getZxy(zoom, tile.x, tile.y, signal);
      if (response?.data) {
        const vectorTile = new VectorTile(new PbfReader(response.data));
        const layer = vectorTile.layers[layerId];
        if (layer) {
          for (let index = 0; index < layer.length; index += 1) {
            const vectorFeature = layer.feature(index);
            if (vectorFeature.type !== 3) continue;
            const feature = vectorFeature.toGeoJSON(tile.x, tile.y, zoom);
            if (!feature.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) continue;
            if (!matchesAnySelectedFeature(feature, selectedFeatures)) continue;
            const key = provinceGroupKey(feature, nameField);
            let group = groups.get(key);
            if (!group) {
              group = { properties: { ...feature.properties }, geometries: [] };
              groups.set(key, group);
            } else {
              mergeSharedProperties(group.properties, feature.properties);
            }
            const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
            const cleanPolygons = polygons.map(cleanPolygon).filter(Boolean);
            if (cleanPolygons.length) group.geometries.push(cleanPolygons);
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
  let dissolved = 0;
  for (const group of groups.values()) {
    if (signal?.aborted) throw new DOMException("Export cancelled.", "AbortError");
    let polygons;
    try {
      polygons = polygonClipping.union(group.geometries[0], ...group.geometries.slice(1));
    } catch (error) {
      throw new Error(`Could not dissolve the selected area's tile edges: ${error.message}`);
    }
    if (polygons.length) features.push({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: polygons }, properties: group.properties });
    dissolved += 1;
    onProgress?.({ stage: "Removing tile seams", completed: dissolved, total: groups.size });
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (!features.length) throw new Error("No province polygons could be assembled from the selected layer.");

  const properties = normalizeProperties(features);
  const collection = {
    type: "FeatureCollection",
    features: features.map((feature) => ({ ...feature, properties: properties(feature.properties) }))
  };
  onProgress?.({ stage: "Creating Shapefile ZIP", completed: 0, total: 1 });
  const components = createShapefileComponents(collection.features);
  const baseName = "indonesia_provinces";
  const zipBytes = zipSync({
    [`${baseName}.shp`]: components.shp,
    [`${baseName}.shx`]: components.shx,
    [`${baseName}.dbf`]: components.dbf,
    [`${baseName}.prj`]: strToU8('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]'),
    [`${baseName}.cpg`]: strToU8("UTF-8\n")
  }, { level: 0 });
  const names = selectedFeatures.map((feature) => getFeatureName(feature.properties || {}));
  const name = selectedFeatures.length === 1 ? names[0] : `${selectedFeatures.length} selected areas`;
  const fileName = selectedFeatures.length === 1
    ? names[0].normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "selected_area"
    : `selected_areas_${selectedFeatures.length}`;
  onProgress?.({ stage: "Ready", completed: 1, total: 1, count: features.length });
  return { blob: new Blob([zipBytes], { type: "application/zip" }), count: features.length, zoom, name, fileName };
}

async function findFeatureTiles(archive, selectedFeatures, layerId, minZoom, maxZoom, bounds, { signal, onProgress } = {}) {
  const [{ VectorTile }, { PbfReader }] = await Promise.all([import("@mapbox/vector-tile"), import("pbf")]);
  // Locate the feature at a useful intermediate zoom, where the national tile
  // range stays practical and small islands are less likely to be generalized away.
  const coarseZoom = Math.min(maxZoom, Math.max(minZoom, 8));
  const candidates = tilesForBounds(bounds, coarseZoom);
  if (candidates.length > MAX_CANDIDATE_TILES) throw new Error("The archive's coverage is too large to search safely in this browser.");
  const matched = [];
  let cursor = 0;
  let coarseCompleted = 0;
  onProgress?.({ stage: "Locating selected area", completed: 0, total: candidates.length });
  async function readCoarse() {
    while (cursor < candidates.length) {
      signal?.throwIfAborted();
      const tile = candidates[cursor++];
      const response = await archive.getZxy(coarseZoom, tile.x, tile.y, signal);
      if (!response?.data) {
        coarseCompleted += 1;
        onProgress?.({ stage: "Locating selected area", completed: coarseCompleted, total: candidates.length });
        continue;
      }
      const layer = new VectorTile(new PbfReader(response.data)).layers[layerId];
      if (layer) {
        for (let index = 0; index < layer.length; index += 1) {
          const feature = layer.feature(index);
          if (feature.type === 3 && matchesAnySelectedFeature({ properties: feature.properties, id: feature.id }, selectedFeatures)) {
            matched.push(feature.toGeoJSON(tile.x, tile.y, coarseZoom));
          }
        }
      }
      coarseCompleted += 1;
      onProgress?.({ stage: "Locating selected area", completed: coarseCompleted, total: candidates.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => readCoarse()));
  if (!matched.length) return [];

  // A one coarse-tile margin catches detached pieces near the outer edge while
  // keeping maximum-zoom reads focused around each selected area.
  const margin = 360 / (2 ** coarseZoom);
  const highDetailTileMap = new Map();
  for (const feature of matched) {
    const extent = geometryBounds([feature.geometry].filter(Boolean));
    if (!extent) continue;
    const localBounds = {
      minLon: Math.max(bounds.minLon, extent.minLon - margin),
      minLat: Math.max(bounds.minLat, extent.minLat - margin),
      maxLon: Math.min(bounds.maxLon, extent.maxLon + margin),
      maxLat: Math.min(bounds.maxLat, extent.maxLat + margin)
    };
    for (const tile of tilesForBounds(localBounds, maxZoom)) highDetailTileMap.set(`${tile.x}/${tile.y}`, tile);
    if (highDetailTileMap.size > MAX_CANDIDATE_TILES) throw new Error("The selected areas' full-detail coverage is too large for a browser export.");
  }
  const highDetailTiles = [...highDetailTileMap.values()];
  if (!highDetailTiles.length) return [];
  if (highDetailTiles.length > MAX_CANDIDATE_TILES) throw new Error("This selected area's full-detail coverage is too large for a browser export.");

  // Eliminate empty coordinates from the candidate rectangle by retaining only
  // tile coordinates that actually contain the matching feature at max zoom.
  const present = [];
  cursor = 0;
  let checked = 0;
  onProgress?.({ stage: `Finding source detail at zoom ${maxZoom}`, completed: 0, total: highDetailTiles.length });
  async function checkHighDetail() {
    while (cursor < highDetailTiles.length) {
      signal?.throwIfAborted();
      const tile = highDetailTiles[cursor++];
      const response = await archive.getZxy(maxZoom, tile.x, tile.y, signal);
      if (!response?.data) continue;
      const layer = new VectorTile(new PbfReader(response.data)).layers[layerId];
      if (!layer) continue;
      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);
        if (feature.type === 3 && matchesAnySelectedFeature({ properties: feature.properties, id: feature.id }, selectedFeatures)) {
          present.push({ ...tile, data: response.data });
          if (present.length > MAX_EXPORT_TILES) {
            throw new Error(`The selected area needs more than ${MAX_EXPORT_TILES.toLocaleString()} source tiles at zoom ${maxZoom}, above this browser export's safe tile limit.`);
          }
          break;
        }
      }
      checked += 1;
      onProgress?.({ stage: `Finding source detail at zoom ${maxZoom}`, completed: checked, total: highDetailTiles.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, highDetailTiles.length) }, () => checkHighDetail()));
  return present;
}

function tilesForBounds(bounds, zoom) {
  const scale = 2 ** zoom;
  const tileX = (longitude) => Math.max(0, Math.min(scale - 1, Math.floor((longitude + 180) / 360 * scale)));
  const tileY = (latitude) => {
    const radians = latitude * Math.PI / 180;
    return Math.max(0, Math.min(scale - 1, Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale)));
  };
  const minX = tileX(bounds.minLon), maxX = tileX(bounds.maxLon);
  const minY = tileY(bounds.maxLat), maxY = tileY(bounds.minLat);
  const tiles = [];
  for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) tiles.push({ x, y });
  return tiles;
}

function geometryBounds(geometries) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const visit = (coordinates) => {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
      minLon = Math.min(minLon, coordinates[0]); maxLon = Math.max(maxLon, coordinates[0]);
      minLat = Math.min(minLat, coordinates[1]); maxLat = Math.max(maxLat, coordinates[1]);
      return;
    }
    for (const child of coordinates) visit(child);
  };
  for (const geometry of geometries) visit(geometry.coordinates);
  return Number.isFinite(minLon) ? { minLon, minLat, maxLon, maxLat } : null;
}

function cleanPolygon(polygon) {
  if (!Array.isArray(polygon)) return null;
  const rings = polygon.map((ring) => {
    if (!Array.isArray(ring)) return null;
    const clean = [];
    for (const point of ring) {
      const x = Number(point?.[0]);
      const y = Number(point?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const previous = clean[clean.length - 1];
      if (!previous || previous[0] !== x || previous[1] !== y) clean.push([x, y]);
    }
    if (clean.length > 1) {
      const first = clean[0];
      const last = clean[clean.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) clean.push([...first]);
    }
    const distinct = new Set(clean.slice(0, -1).map(([x, y]) => `${x},${y}`));
    return distinct.size >= 3 && clean.length >= 4 ? clean : null;
  }).filter(Boolean);
  return rings.length ? rings : null;
}

function matchesAnySelectedFeature(candidate, selectedFeatures) {
  return selectedFeatures.some((selected) => {
    if (!selected) return false;
    const target = selected.properties || {};
    const entries = Object.entries(target).filter(([, value]) => value != null && ["string", "number", "boolean"].includes(typeof value));
    if (!entries.length && selected.id != null) return String(candidate.id) === String(selected.id);
    return entries.length > 0 && entries.every(([key, value]) => String(candidate.properties?.[key] ?? "") === String(value));
  });
}

function getFeatureName(properties) {
  const preferredFields = ["WADMKC", "KECAMATAN", "NAMOBJ", "NAME_3", "name_3", "name", "NAME_1", "nama", "nama_prov", "shapeName", "admin"];
  for (const field of preferredFields) {
    const entry = Object.entries(properties).find(([key, value]) => normalizeKey(key) === normalizeKey(field) && value != null && String(value).trim());
    if (entry) return String(entry[1]).trim();
  }
  return "selected_area";
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

function createShapefileComponents(features) {
  const encoder = new TextEncoder();
  const geometries = features.map((feature) => feature.geometry.coordinates);
  const allPoints = geometries.flat(2);
  const bounds = allPoints.reduce((result, [x, y]) => ({
    minX: Math.min(result.minX, x), minY: Math.min(result.minY, y),
    maxX: Math.max(result.maxX, x), maxY: Math.max(result.maxY, y)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const records = geometries.map((polygons) => {
    const rings = polygons.flatMap((polygon) => polygon);
    const points = rings.flat();
    return { rings, points, bounds: points.reduce((result, [x, y]) => ({
      minX: Math.min(result.minX, x), minY: Math.min(result.minY, y),
      maxX: Math.max(result.maxX, x), maxY: Math.max(result.maxY, y)
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }) };
  });

  const shpRecordBytes = records.map((record) => 4 + 32 + 4 + 4 + 4 * record.rings.length + 16 * record.points.length);
  const shpSize = 100 + shpRecordBytes.reduce((sum, size) => sum + 8 + size, 0);
  const shxSize = 100 + records.length * 8;
  const shp = new Uint8Array(shpSize);
  const shx = new Uint8Array(shxSize);
  writeShapeHeader(shp, shpSize, bounds);
  writeShapeHeader(shx, shxSize, bounds);
  const shpView = new DataView(shp.buffer);
  const shxView = new DataView(shx.buffer);
  let shpOffset = 100;
  let shxOffset = 100;
  let recordOffsetWords = 50;
  records.forEach((record, index) => {
    const contentBytes = shpRecordBytes[index];
    shpView.setInt32(shpOffset, index + 1, false);
    shpView.setInt32(shpOffset + 4, contentBytes / 2, false);
    shxView.setInt32(shxOffset, recordOffsetWords, false);
    shxView.setInt32(shxOffset + 4, contentBytes / 2, false);
    let cursor = shpOffset + 8;
    shpView.setInt32(cursor, 5, true); cursor += 4;
    writeBounds(shpView, cursor, record.bounds); cursor += 32;
    shpView.setInt32(cursor, record.rings.length, true); cursor += 4;
    shpView.setInt32(cursor, record.points.length, true); cursor += 4;
    let pointOffset = 0;
    for (const ring of record.rings) {
      shpView.setInt32(cursor, pointOffset, true); cursor += 4;
      pointOffset += ring.length;
    }
    for (const [x, y] of record.points) {
      shpView.setFloat64(cursor, x, true); cursor += 8;
      shpView.setFloat64(cursor, y, true); cursor += 8;
    }
    shpOffset += 8 + contentBytes;
    shxOffset += 8;
    recordOffsetWords += (8 + contentBytes) / 2;
  });

  const fields = [...new Set(features.flatMap((feature) => Object.keys(feature.properties || {})))];
  const fieldWidth = 254;
  const recordWidth = 1 + fields.length * fieldWidth;
  const headerLength = 32 + fields.length * 32 + 1;
  const dbf = new Uint8Array(headerLength + recordWidth * features.length + 1);
  const dbfView = new DataView(dbf.buffer);
  dbfView.setUint8(0, 0x03);
  const now = new Date();
  dbfView.setUint8(1, now.getFullYear() - 1900);
  dbfView.setUint8(2, now.getMonth() + 1);
  dbfView.setUint8(3, now.getDate());
  dbfView.setUint32(4, features.length, true);
  dbfView.setUint16(8, headerLength, true);
  dbfView.setUint16(10, recordWidth, true);
  fields.forEach((field, index) => {
    const name = encoder.encode(field.slice(0, 10));
    const offset = 32 + index * 32;
    dbf.set(name.subarray(0, 10), offset);
    dbfView.setUint8(offset + 11, 0x43);
    dbfView.setUint8(offset + 16, fieldWidth);
  });
  dbfView.setUint8(headerLength - 1, 0x0d);
  features.forEach((feature, rowIndex) => {
    const rowOffset = headerLength + rowIndex * recordWidth;
    dbfView.setUint8(rowOffset, 0x20);
    fields.forEach((field, fieldIndex) => {
      const raw = feature.properties[field] ?? "";
      const text = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
      const bytes = encoder.encode(text).subarray(0, fieldWidth);
      dbf.set(bytes, rowOffset + 1 + fieldIndex * fieldWidth);
    });
  });
  dbfView.setUint8(dbf.length - 1, 0x1a);
  return { shp, shx, dbf };
}

function writeShapeHeader(bytes, fileSize, bounds) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setInt32(0, 9994, false);
  view.setInt32(24, fileSize / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, 5, true);
  writeBounds(view, 36, bounds);
}

function writeBounds(view, offset, bounds) {
  view.setFloat64(offset, bounds.minX, true);
  view.setFloat64(offset + 8, bounds.minY, true);
  view.setFloat64(offset + 16, bounds.maxX, true);
  view.setFloat64(offset + 24, bounds.maxY, true);
}
