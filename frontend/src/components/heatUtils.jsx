import * as THREE from "three";

/* ---------------- constants ---------------- */

export const MAP_SIZE = 18; // width of the whole NCR in scene units
export const MAP_ROT = -0.35; // y-rotation of the map group
export const SLAB = 0.14; // thickness of the dark map slab
export const TEX = 320; // heat texture resolution (pixels per side)
export const SMOOTH = 0.15; // interpolation smoothing, in scene units (median station spacing is about 0.1)
export const RADIUS = 1.4; // heat fades out beyond about this distance from any station (1 unit is roughly 20 km)
export const NO_DATA = [58, 72, 87]; // neutral colour where no station is near

export const COLORS = {
  low: "#3ddc97",
  moderate: "#f5c451",
  high: "#ff8a4c",
  veryHigh: "#ff4d6d",
};

// Colour ramp for the heat map. Stops sit at the middle of each risk band
// (Low 0-60, Moderate 60-120, High 120-250, Very High 250+).
export const RAMP = [
  [30, "#3ddc97"],
  [90, "#f5c451"],
  [185, "#ff8a4c"],
  [300, "#ff4d6d"],
];

export function getRisk(pm25) {
  if (pm25 < 60) return "low";
  if (pm25 < 120) return "moderate";
  if (pm25 < 250) return "high";
  return "veryHigh";
}

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const RAMP_RGB = RAMP.map(([v, hex]) => [v, hexToRgb(hex)]);

// PM2.5 value -> [r, g, b]
export function heatRGB(value) {
  if (value <= RAMP_RGB[0][0]) return RAMP_RGB[0][1];
  const last = RAMP_RGB[RAMP_RGB.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 0; i < RAMP_RGB.length - 1; i++) {
    const [v0, c0] = RAMP_RGB[i];
    const [v1, c1] = RAMP_RGB[i + 1];
    if (value <= v1) {
      const t = (value - v0) / (v1 - v0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t),
      ];
    }
  }
  return last[1];
}

/* ---------------- CSV ---------------- */

// quote-aware split so "Anand Vihar, Delhi" stays one field
export function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const headers = splitCSVLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = splitCSVLine(line);
    return headers.reduce((row, h, i) => {
      row[h] = values[i]?.trim() ?? "";
      return row;
    }, {});
  });
}

// latest observation per station
export function latestStations(rows) {
  const latest = {};
  rows.forEach((r) => {
    const id = r.location_id;
    if (!id || !r.latitude || !r.longitude || !r.pm25) return;
    if (!latest[id] || r.date > latest[id].date) {
      latest[id] = {
        id: Number(id),
        name: r.location_name || "Monitoring station",
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        pm25: Number(r.pm25),
        date: r.date,
      };
    }
  });
  return Object.values(latest).filter(
    (s) =>
      Number.isFinite(s.id) &&
      Number.isFinite(s.pm25) &&
      Number.isFinite(s.latitude) &&
      Number.isFinite(s.longitude)
  );
}

/* ---------------- geometry ---------------- */

export const polygonsOf = (g) =>
  !g
    ? []
    : g.type === "Polygon"
    ? [g.coordinates]
    : g.type === "MultiPolygon"
    ? g.coordinates
    : [];

// Projection centred on the whole region, with cos(lat) correction.
// Returns [x, north]; in 3D: x -> X, north -> -Z.
export function makeProjector(geojsons) {
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;
  geojsons.forEach((geojson) =>
    geojson.features.forEach((f) =>
      polygonsOf(f.geometry).forEach((poly) =>
        poly[0].forEach(([lng, lat]) => {
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        })
      )
    )
  );
  const cLng = (minLng + maxLng) / 2;
  const cLat = (minLat + maxLat) / 2;
  const k = Math.cos((cLat * Math.PI) / 180);
  const span = Math.max((maxLng - minLng) * k, maxLat - minLat);
  const s = MAP_SIZE / span;
  return ([lng, lat]) => [(lng - cLng) * k * s, (lat - cLat) * s];
}

// bounding box of everything, in projected units
export function projectedExtent(geojsons, project) {
  let minX = Infinity, maxX = -Infinity;
  let minN = Infinity, maxN = -Infinity;
  geojsons.forEach((geojson) =>
    geojson.features.forEach((f) =>
      polygonsOf(f.geometry).forEach((poly) =>
        poly[0].forEach((pt) => {
          const [x, n] = project(pt);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (n < minN) minN = n;
          if (n > maxN) maxN = n;
        })
      )
    )
  );
  return { minX, maxX, minN, maxN, W: maxX - minX, H: maxN - minN };
}

const toVec2 = (ring, project) =>
  ring.map((p) => new THREE.Vector2(...project(p)));

function polygonToShape(poly, project) {
  const shape = new THREE.Shape(toVec2(poly[0], project));
  poly.slice(1).forEach((hole) =>
    shape.holes.push(new THREE.Path(toVec2(hole, project)))
  );
  return shape;
}

// flat surface (carries the heat texture); its UVs are the raw (x, north) values
export function surfaceGeometry(polys, project) {
  const g = new THREE.ShapeGeometry(polys.map((p) => polygonToShape(p, project)), 1);
  g.rotateX(-Math.PI / 2); // lie flat; north becomes -Z
  return g;
}

// dark slab under the surface
export function slabGeometry(polys, project, depth = SLAB) {
  const g = new THREE.ExtrudeGeometry(
    polys.map((p) => polygonToShape(p, project)),
    { depth, bevelEnabled: false, curveSegments: 1 }
  );
  g.rotateX(-Math.PI / 2);
  return g;
}

export function outlinePoints(ring, project, y) {
  return ring.map((p) => {
    const [x, n] = project(p);
    return [x, y, -n];
  });
}

function getName(props = {}, i) {
  const keys = ["name", "NAME", "Name", "district", "DISTRICT", "dtname", "NAME_2", "DISTRICT_N"];
  for (const k of keys) if (typeof props[k] === "string" && props[k]) return props[k];
  const first = Object.values(props).find((v) => typeof v === "string" && v);
  return first || `Area ${i + 1}`;
}

// layers: [{ geojson, group }]  (Delhi first)
export function buildDistrictRecords(layers, project) {
  const list = [];
  layers.forEach(({ geojson, group }) => {
    if (!geojson) return;
    geojson.features.forEach((f) => {
      const polys = polygonsOf(f.geometry);
      if (!polys.length) return;
      list.push({
        id: list.length,
        name: getName(f.properties, list.length),
        state: f.properties?.state || (group === "Delhi" ? "Delhi" : ""),
        group,
        polys,
        geometry: surfaceGeometry(polys, project),
        outlines: polys.flatMap((p) => p.map((r) => outlinePoints(r, project, SLAB + 0.012))),
      });
    });
  });
  return list;
}

/* ---------------- heat interpolation ---------------- */

// Smoothed inverse-distance weighting. valueAt() returns the interpolated value
// and a confidence (1 next to a station, fading to 0 far from every station).
// The texture blends towards a neutral colour where confidence is low, so the map
// never paints a value where there is no nearby measurement.
// Pixel row 0 is the northern edge.
export function computeHeat(stations, project, ext, size = TEX) {
  const pts = stations.map((s) => {
    const [x, n] = project([s.longitude, s.latitude]);
    return { x, n, v: s.pm25 };
  });
  const s2 = SMOOTH * SMOOTH;
  const r2 = RADIUS * RADIUS;

  const valueAt = (x, n) => {
    let num = 0, den = 0, nearest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = x - pts[i].x;
      const dn = n - pts[i].n;
      const d2 = dx * dx + dn * dn;
      if (d2 < nearest) nearest = d2;
      const w = 1 / (d2 + s2);
      num += w * pts[i].v;
      den += w;
    }
    return den ? { value: num / den, conf: Math.exp(-nearest / r2) } : { value: null, conf: 0 };
  };

  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let r = 0; r < size; r++) {
    const n = ext.maxN - ((r + 0.5) / size) * ext.H;
    for (let c = 0; c < size; c++) {
      const x = ext.minX + ((c + 0.5) / size) * ext.W;
      const { value, conf } = valueAt(x, n);
      const heat = value == null ? NO_DATA : heatRGB(value);
      const i = (r * size + c) * 4;
      pixels[i] = Math.round(NO_DATA[0] + (heat[0] - NO_DATA[0]) * conf);
      pixels[i + 1] = Math.round(NO_DATA[1] + (heat[1] - NO_DATA[1]) * conf);
      pixels[i + 2] = Math.round(NO_DATA[2] + (heat[2] - NO_DATA[2]) * conf);
      pixels[i + 3] = 255;
    }
  }
  return { pixels, valueAt };
}

// canvas texture whose UV transform maps projected (x, north) onto the image
export function heatTexture(pixels, ext, size = TEX) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(pixels, size, size), 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(1 / ext.W, 1 / ext.H);
  texture.offset.set(-ext.minX / ext.W, -ext.minN / ext.H);
  texture.anisotropy = 4;
  return texture;
}