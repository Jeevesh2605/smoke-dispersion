import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Line, useCursor } from "@react-three/drei";
import * as THREE from "three";
import "./NCRMap.css";

const NCR_URL = "/data/ncr.geojson";
const DELHI_URL = "/data/delhi-districts.geojson";
const AQI_URL = "/data/aqi_recent.csv";

const BG = "#0e1217";
const BASE_Y = 0.06; // thickness of the NCR base slab
const DELHI_SIZE = 6; // Delhi's width in scene units (bigger = bigger Delhi)

const COLORS = {
  low: "#3ddc97",
  moderate: "#f5c451",
  high: "#ff8a4c",
  veryHigh: "#ff4d6d",
};
const LABELS = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  veryHigh: "Very High",
};

function getRisk(pm25) {
  if (pm25 < 60) return "low";
  if (pm25 < 120) return "moderate";
  if (pm25 < 250) return "high";
  return "veryHigh";
}

const noRaycast = () => null; // decorative objects must not block hover/click

/* ---------------- data helpers ---------------- */

// quote-aware split so "Anand Vihar, Delhi" stays one field
function splitCSVLine(line) {
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

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const headers = splitCSVLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const values = splitCSVLine(line);
    return headers.reduce((row, h, i) => {
      row[h] = values[i]?.trim() ?? "";
      return row;
    }, {});
  });
  return { headers, rows };
}

function latestStations({ headers, rows }) {
  const latest = {};
  rows.forEach((r) => {
    const id = r.location_id;
    if (!id || !r.latitude || !r.longitude || !r.pm25) return;
    if (!latest[id] || r.date > latest[id].date) {
      latest[id] = {
        location_id: Number(id),
        location_name: r.location_name || "Monitoring station",
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        pm25: Number(r.pm25),
        date: r.date,
      };
    }
  });
  const stations = Object.values(latest).filter(
    (s) =>
      Number.isFinite(s.pm25) &&
      Number.isFinite(s.latitude) &&
      Number.isFinite(s.longitude)
  );
  if (!stations.length) {
    console.warn(
      "No stations parsed from aqi_recent.csv. Headers found:",
      headers,
      "Expected: location_id, latitude, longitude, pm25, date"
    );
  }
  return stations;
}

/* ---------------- geometry helpers ---------------- */

const polygonsOf = (g) =>
  !g
    ? []
    : g.type === "Polygon"
    ? [g.coordinates]
    : g.type === "MultiPolygon"
    ? g.coordinates
    : [];

// Delhi-centred projection with cos(lat) correction.
// Returns [x, north]; in 3D: x -> X, north -> -Z.
function makeProjector(geojson) {
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;
  geojson.features.forEach((f) =>
    polygonsOf(f.geometry).forEach((poly) =>
      poly[0].forEach(([lng, lat]) => {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      })
    )
  );
  const cLng = (minLng + maxLng) / 2;
  const cLat = (minLat + maxLat) / 2;
  const k = Math.cos((cLat * Math.PI) / 180);
  const span = Math.max((maxLng - minLng) * k, maxLat - minLat);
  const s = DELHI_SIZE / span;
  return ([lng, lat]) => [(lng - cLng) * k * s, (lat - cLat) * s];
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

function buildGeometry(polys, project, depth) {
  const shapes = polys.map((p) => polygonToShape(p, project));
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: false,
    curveSegments: 1,
  });
  g.rotateX(-Math.PI / 2); // extrusion now goes up (+Y), north is -Z
  return g;
}

function outlinePoints(ring, project, y) {
  return ring.map((p) => {
    const [x, n] = project(p);
    return [x, y, -n];
  });
}

/* point in polygon */
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
const inPolys = (pt, polys) =>
  polys.some(
    (p) => inRing(pt, p[0]) && !p.slice(1).some((h) => inRing(pt, h))
  );

function centroidOf(polys) {
  const ring = polys.reduce((a, b) => (b[0].length > a[0].length ? b : a))[0];
  const sum = ring.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

// inverse-distance weighting for districts with no station inside
function idw(pt, stations) {
  if (!stations.length) return null;
  let num = 0, den = 0;
  stations.forEach((s) => {
    const d2 =
      (s.longitude - pt[0]) ** 2 + (s.latitude - pt[1]) ** 2 || 1e-9;
    num += s.pm25 / d2;
    den += 1 / d2;
  });
  return den ? num / den : null;
}

function getName(props = {}, i) {
  const keys = ["name", "NAME", "Name", "district", "DISTRICT", "dtname", "NAME_2", "DISTRICT_N"];
  for (const k of keys) if (typeof props[k] === "string" && props[k]) return props[k];
  const first = Object.values(props).find((v) => typeof v === "string" && v);
  return first || `Area ${i + 1}`;
}

const MIN_H = 0.2;
const MAX_H = 1.0;

function buildDistricts(delhi, stations, project) {
  const list = delhi.features
    .map((f, i) => {
      const polys = polygonsOf(f.geometry);
      if (!polys.length) return null;
      const inside = stations.filter((s) =>
        inPolys([s.longitude, s.latitude], polys)
      );
      const c = centroidOf(polys);
      const pm25 = inside.length
        ? inside.reduce((a, s) => a + s.pm25, 0) / inside.length
        : idw(c, stations);
      return {
        id: i,
        name: getName(f.properties, i),
        polys,
        pm25,
        count: inside.length,
        centroid: c,
      };
    })
    .filter(Boolean);

  // heights are relative: highest PM2.5 district is tallest, lowest is shortest
  const vals = list.map((d) => d.pm25).filter((v) => v != null);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);

  return list.map((d) => ({
    ...d,
    height:
      d.pm25 == null
        ? 0.15
        : MIN_H + ((d.pm25 - lo) / (hi - lo || 1)) * (MAX_H - MIN_H),
  }));
}

/* ---------------- 3D pieces: districts & stations ---------------- */

const INIT_SCALE = [1, 0.001, 1];

function District({ d, project, selected, onSelect, onHover }) {
  const group = useRef();
  const [hovered, setHovered] = useState(false);
  useCursor(hovered);

  const risk = d.pm25 == null ? null : getRisk(d.pm25);
  const color = risk ? COLORS[risk] : "#4a5563";
  const active = hovered || selected;
  const target = d.height + (hovered ? 0.07 : 0);

  const geometry = useMemo(
    () => buildGeometry(d.polys, project, 1),
    [d.polys, project]
  );
  const outlines = useMemo(
    () => d.polys.flatMap((p) => p.map((r) => outlinePoints(r, project, 1.004))),
    [d.polys, project]
  );

  useFrame((_, delta) => {
    if (!group.current) return;
    group.current.scale.y = THREE.MathUtils.damp(
      group.current.scale.y,
      target,
      5,
      delta
    );
  });

  const tip = (e) =>
    onHover({
      name: d.name,
      value: d.pm25 == null ? "No data" : `${Math.round(d.pm25)} µg/m³`,
      x: e.nativeEvent.offsetX,
      y: e.nativeEvent.offsetY,
    });

  return (
    <group position={[0, BASE_Y, 0]}>
      <group ref={group} scale={INIT_SCALE}>
        <mesh
          geometry={geometry}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(true);
            tip(e);
          }}
          onPointerMove={(e) => {
            e.stopPropagation();
            tip(e);
          }}
          onPointerOut={() => {
            setHovered(false);
            onHover(null);
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(d);
          }}
        >
          <meshStandardMaterial
            color={color}
            roughness={0.55}
            metalness={0.1}
            emissive={color}
            emissiveIntensity={active ? 0.5 : 0.15}
          />
        </mesh>

        {/* district boundaries on the top face */}
        {outlines.map((pts, i) => (
          <Line
            key={i}
            points={pts}
            color={active ? "#ffffff" : "#e9eef5"}
            lineWidth={active ? 2.6 : 1.2}
            transparent
            opacity={active ? 1 : 0.55}
          />
        ))}
      </group>
    </group>
  );
}

// `s.top` = height of the pole, set just above the district under the station
function Station({ s, project, onSelect, onHover }) {
  const [hov, setHov] = useState(false);
  useCursor(hov);
  const [x, n] = project([s.longitude, s.latitude]);
  const color = COLORS[getRisk(s.pm25)];

  const tip = (e) =>
    onHover({
      name: s.location_name,
      value: `${Math.round(s.pm25)} µg/m³`,
      x: e.nativeEvent.offsetX,
      y: e.nativeEvent.offsetY,
    });

  return (
    <group position={[x, BASE_Y, -n]}>
      <mesh position={[0, s.top / 2, 0]} raycast={noRaycast}>
        <cylinderGeometry args={[0.004, 0.004, s.top, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.45} />
      </mesh>
      <mesh
        position={[0, s.top, 0]}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHov(true);
          tip(e);
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
          tip(e);
        }}
        onPointerOut={() => {
          setHov(false);
          onHover(null);
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(s);
        }}
      >
        <sphereGeometry args={[hov ? 0.075 : 0.05, 20, 20]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh position={[0, s.top, 0]} raycast={noRaycast}>
        <sphereGeometry args={[0.1, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} />
      </mesh>
    </group>
  );
}

/* ---------------- 3D pieces: atmosphere ---------------- */

// wind blows NW -> SE: +X is east, +Z is south in scene space
const WIND = new THREE.Vector3(0.4, 0, 0.45);

const SMOKE_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  uniform float uDpr;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uDpr * 260.0 / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const SMOKE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

// A particle plume: puffs rise from `origin`, swell, drift with the wind, fade.
function Plume({
  origin,
  count = 60,
  color = "#9aa3ad",
  rise = 2,
  drift = 1,
  sizeMin = 0.6,
  sizeMax = 2,
  lifeMin = 7,
  lifeMax = 11,
  spread = 0.08,
  opacity = 0.4,
}) {
  const dpr = useThree((s) => s.viewport.dpr);

  const { geometry, state } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(count), 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(count), 1));
    const rnd = (n) => Float32Array.from({ length: n }, Math.random);
    const life = rnd(count).map((r) => lifeMin + r * (lifeMax - lifeMin));
    return {
      geometry: geo,
      state: {
        age: rnd(count),
        life,
        seed: rnd(count),
        jx: rnd(count).map((r) => (r - 0.5) * 2 * spread),
        jz: rnd(count).map((r) => (r - 0.5) * 2 * spread),
      },
    };
  }, [count, lifeMin, lifeMax, spread]);

  const uniforms = useMemo(
    () => ({ uColor: { value: new THREE.Color(color) }, uDpr: { value: dpr } }),
    [color, dpr]
  );

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    const pos = geometry.attributes.position.array;
    const alpha = geometry.attributes.aAlpha.array;
    const size = geometry.attributes.aSize.array;
    const { age, life, seed, jx, jz } = state;

    for (let i = 0; i < count; i++) {
      age[i] += delta / life[i];
      if (age[i] > 1) age[i] -= 1;
      const a = age[i];
      const wob = Math.sin(t * 0.7 + seed[i] * 6.283) * 0.15 * a;
      const run = a * life[i] * 0.9 * drift;

      pos[i * 3] = origin[0] + jx[i] + WIND.x * run + wob;
      pos[i * 3 + 1] = origin[1] + rise * a;
      pos[i * 3 + 2] = origin[2] + jz[i] + WIND.z * run + Math.cos(t * 0.6 + seed[i] * 6.283) * 0.12 * a;

      alpha[i] = opacity * Math.min(a * 8, 1) * (1 - a);
      size[i] = sizeMin + (sizeMax - sizeMin) * a;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
  });

  return (
    <points geometry={geometry} raycast={noRaycast} frustumCulled={false}>
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={SMOKE_VERT}
        fragmentShader={SMOKE_FRAG}
        transparent
        depthWrite={false}
      />
    </points>
  );
}

// flickering ember with an expanding ring
function FireSpot({ position }) {
  const core = useRef();
  const ring = useRef();
  const seed = useMemo(() => Math.random() * 10, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime + seed;
    const flicker = 0.75 + 0.25 * Math.sin(t * 9) * Math.sin(t * 5.3);
    core.current.scale.setScalar(flicker);
    const p = (t * 0.6) % 1;
    ring.current.scale.setScalar(1 + p * 3);
    ring.current.material.opacity = 0.55 * (1 - p);
  });

  return (
    <group position={position}>
      <mesh ref={core} raycast={noRaycast}>
        <sphereGeometry args={[0.06, 16, 16]} />
        <meshBasicMaterial color="#ff7a2f" />
      </mesh>
      <mesh raycast={noRaycast}>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshBasicMaterial color="#ff7a2f" transparent opacity={0.2} depthWrite={false} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
        <ringGeometry args={[0.09, 0.115, 48]} />
        <meshBasicMaterial
          color="#ff7a2f"
          transparent
          opacity={0.5}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

// illustrative emission sources [lng, lat]; not live fire data
const SMOKE_SOURCES = [
  {
    key: "stubble",
    lnglat: [76.88, 28.98],
    color: "#b9a58c",
    count: 70,
    rise: 2.4,
    drift: 1.1,
    sizeMin: 0.7,
    sizeMax: 2.6,
    spread: 0.35,
    opacity: 0.45,
    fires: [[0, 0], [0.3, -0.18], [-0.25, 0.22]],
  },
  {
    key: "industrial",
    lnglat: [77.04, 28.8],
    color: "#8e99a6",
    count: 45,
    rise: 2.0,
    drift: 0.9,
    sizeMin: 0.5,
    sizeMax: 1.9,
    spread: 0.06,
    opacity: 0.4,
  },
  {
    key: "landfill",
    lnglat: [77.33, 28.62],
    color: "#a69887",
    count: 40,
    rise: 1.8,
    drift: 0.8,
    sizeMin: 0.5,
    sizeMax: 1.7,
    spread: 0.08,
    opacity: 0.38,
    fires: [[0, 0]],
  },
];

function Atmosphere({ project }) {
  return (
    <>
      {SMOKE_SOURCES.map((s) => {
        const [x, n] = project(s.lnglat);
        const origin = [x, BASE_Y + 0.03, -n];
        return (
          <group key={s.key}>
            <Plume origin={origin} {...s} />
            {s.fires?.map(([dx, dz], i) => (
              <FireSpot key={i} position={[origin[0] + dx, origin[1], origin[2] + dz]} />
            ))}
          </group>
        );
      })}

      {/* ambient haze: kept light so it doesn't wash out the map */}
      <Plume
        origin={[-3.4, 0.4, -2.6]}
        count={50}
        color="#c9d3de"
        rise={0.9}
        drift={1.5}
        sizeMin={0.1}
        sizeMax={0.18}
        lifeMin={9}
        lifeMax={15}
        spread={3.2}
        opacity={0.12}
      />
    </>
  );
}

// bobbing pointer with a pulsing ring
function HotspotPin({ position, color, name, value, onHover }) {
  const head = useRef();
  const ring = useRef();
  const [hov, setHov] = useState(false);
  useCursor(hov);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    head.current.position.y = 0.38 + Math.sin(t * 2) * 0.06;
    head.current.rotation.y = t * 0.9;
    const p = (t * 0.7) % 1;
    ring.current.scale.setScalar(1 + p * 4);
    ring.current.material.opacity = 0.6 * (1 - p);
  });

  const tip = (e) =>
    onHover({
      name: `Highest PM2.5 · ${name}`,
      value,
      x: e.nativeEvent.offsetX,
      y: e.nativeEvent.offsetY,
    });

  return (
    <group position={position}>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={noRaycast}>
        <ringGeometry args={[0.1, 0.13, 48]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.6}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      <group
        ref={head}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHov(true);
          tip(e);
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
          tip(e);
        }}
        onPointerOut={() => {
          setHov(false);
          onHover(null);
        }}
      >
        {/* cone tip points down */}
        <mesh rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[0.085, 0.24, 20]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
        </mesh>
        <mesh position={[0, 0.17, 0]} scale={hov ? 1.2 : 1}>
          <sphereGeometry args={[0.1, 20, 20]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
        </mesh>
        <mesh position={[0, 0.17, 0]}>
          <sphereGeometry args={[0.04, 12, 12]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      </group>
    </group>
  );
}

/* ---------------- scene ---------------- */

function Scene({
  ncr,
  districts,
  stations,
  hotspot,
  project,
  selectedKey,
  onDistrict,
  onStation,
  onHover,
}) {
  const ncrPolys = useMemo(
    () => ncr.features.flatMap((f) => polygonsOf(f.geometry)),
    [ncr]
  );
  const ncrGeometry = useMemo(
    () => buildGeometry(ncrPolys, project, BASE_Y),
    [ncrPolys, project]
  );
  const ncrOutlines = useMemo(
    () => ncrPolys.map((p) => outlinePoints(p[0], project, BASE_Y + 0.003)),
    [ncrPolys, project]
  );

  // station poles end just above the district they sit in; outside Delhi: short fixed pole
  const stationsWithTop = useMemo(
    () =>
      stations.map((s) => {
        const d = districts.find((dd) =>
          inPolys([s.longitude, s.latitude], dd.polys)
        );
        return { ...s, top: d ? d.height + 0.14 : 0.35 };
      }),
    [stations, districts]
  );

  // pin goes on the worst district; falls back to Connaught Place until data loads
  const pin = useMemo(() => {
    const lnglat = hotspot ? hotspot.centroid : [77.2167, 28.6315];
    const [x, n] = project(lnglat);
    return {
      position: [x, BASE_Y + (hotspot ? hotspot.height : 0.15), -n],
      color: hotspot ? COLORS[getRisk(hotspot.pm25)] : "#d85c7a",
      name: hotspot ? hotspot.name : "New Delhi",
      value: hotspot ? `${Math.round(hotspot.pm25)} µg/m³` : "Awaiting data",
    };
  }, [hotspot, project]);

  return (
    <>
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 14, 30]} />

      <ambientLight intensity={0.9} />
      <directionalLight position={[5, 9, 6]} intensity={2.2} />
      <directionalLight position={[-6, 4, -4]} intensity={0.6} color="#7aa7ff" />

      <gridHelper args={[60, 60, "#1c2530", "#141b23"]} position={[0, -0.02, 0]} />

      <group rotation={[0, -0.35, 0]}>
        {/* NCR base */}
        <mesh geometry={ncrGeometry} raycast={noRaycast}>
          <meshStandardMaterial color="#18212b" roughness={0.9} />
        </mesh>
        {ncrOutlines.map((pts, i) => (
          <Line
            key={i}
            points={pts}
            color="#3a4857"
            lineWidth={1}
            dashed
            dashSize={0.12}
            gapSize={0.1}
          />
        ))}

        {/* Delhi districts */}
        {districts.map((d) => (
          <District
            key={d.id}
            d={d}
            project={project}
            selected={selectedKey === `d-${d.id}`}
            onSelect={onDistrict}
            onHover={onHover}
          />
        ))}

        {/* stations */}
        {stationsWithTop.map((s) => (
          <Station
            key={s.location_id}
            s={s}
            project={project}
            onSelect={onStation}
            onHover={onHover}
          />
        ))}

        {/* smoke, fires, haze, pointer */}
        <Atmosphere project={project} />
        <HotspotPin {...pin} onHover={onHover} />
      </group>
    </>
  );
}

/* ---------------- main component ---------------- */

export default function NCRMap() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const tipRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const get = (url, kind) =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        return r[kind]();
      });

    Promise.all([get(NCR_URL, "json"), get(DELHI_URL, "json"), get(AQI_URL, "text")])
      .then(([ncr, delhi, csv]) => {
        if (!cancelled)
          setData({ ncr, delhi, stations: latestStations(parseCSV(csv)) });
      })
      .catch((e) => console.error("Failed to load map data:", e));

    return () => {
      cancelled = true;
    };
  }, []);

  const project = useMemo(() => (data ? makeProjector(data.delhi) : null), [data]);
  const districts = useMemo(
    () => (data && project ? buildDistricts(data.delhi, data.stations, project) : []),
    [data, project]
  );
  const hotspot = useMemo(() => {
    const withData = districts.filter((d) => d.pm25 != null);
    return withData.length
      ? withData.reduce((a, b) => (b.pm25 > a.pm25 ? b : a))
      : null;
  }, [districts]);

  // tooltip is updated through the DOM so pointer moves don't re-render React
  const showTip = (info) => {
    const el = tipRef.current;
    if (!el) return;
    if (!info) {
      el.style.opacity = 0;
      return;
    }
    el.firstChild.textContent = info.name;
    el.lastChild.textContent = info.value;
    el.style.transform = `translate(${info.x + 14}px, ${info.y + 14}px)`;
    el.style.opacity = 1;
  };

  if (!data || !project) {
    return (
      <div className="map-loading">
        <div className="loading-dot" />
        Loading Delhi-NCR air map...
      </div>
    );
  }

  const pickDistrict = (d) =>
    setSelected({
      key: `d-${d.id}`,
      label: "AREA AVERAGE",
      title: d.name,
      pm25: d.pm25,
      note:
        d.pm25 == null
          ? "No data for this area"
          : d.count
          ? `Average of ${d.count} station${d.count > 1 ? "s" : ""}`
          : "Estimated from nearby stations",
    });

  const pickStation = (s) =>
    setSelected({
      key: `s-${s.location_id}`,
      label: "LATEST OBSERVATION",
      title: s.location_name,
      pm25: s.pm25,
      note: `Latest PM2.5 observation · ${s.date}`,
    });

  const risk = selected && selected.pm25 != null ? getRisk(selected.pm25) : null;

  return (
    <div className="ncr-map-container">
      <div className="map-header">
        <div>
          <span className="map-kicker">LIVE AIR OUTLOOK</span>
          <h3>Delhi-NCR</h3>
        </div>
        <div className="station-count">
          <strong>{data.stations.length}</strong>
          <span>stations</span>
        </div>
      </div>

      <div className="map-wind">
        <i /> Smoke drift · NW → SE
      </div>

      <div className="three-map">
        <Canvas
          camera={{ position: [-4, 7, 9], fov: 35 }}
          dpr={[1, 2]}
          onPointerMissed={() => setSelected(null)}
        >
          <Scene
            ncr={data.ncr}
            districts={districts}
            stations={data.stations}
            hotspot={hotspot}
            project={project}
            selectedKey={selected?.key}
            onDistrict={pickDistrict}
            onStation={pickStation}
            onHover={showTip}
          />
          <OrbitControls
            makeDefault
            enablePan={false}
            enableDamping
            minDistance={7}
            maxDistance={18}
            minPolarAngle={0.35}
            maxPolarAngle={1.35}
            target={[0, 0.2, 0]}
          />
        </Canvas>
      </div>

      {/* hover tooltip: name only appears under the pointer */}
      <div className="map-tip" ref={tipRef}>
        <span />
        <b />
      </div>

      <div className="map-legend">
        {Object.entries(COLORS).map(([key, c]) => (
          <span key={key}>
            <i style={{ background: c, boxShadow: `0 0 8px ${c}` }} />
            {LABELS[key]}
          </span>
        ))}
      </div>

      {selected && (
        <div className="station-card">
          <button className="close-button" onClick={() => setSelected(null)}>
            ×
          </button>
          <span className="station-card-label">{selected.label}</span>
          <h4>{selected.title}</h4>
          {selected.pm25 != null && (
            <>
              <div className="pm-value">
                {selected.pm25.toFixed(1)}
                <span>µg/m³</span>
              </div>
              <div className="risk-pill" style={{ color: COLORS[risk] }}>
                {LABELS[risk]}
              </div>
            </>
          )}
          <p>{selected.note}</p>
        </div>
      )}
    </div>
  );
}