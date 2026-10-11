import { useEffect, useMemo, useRef, useState } from "react";

import { Canvas, useFrame, useThree } from "@react-three/fiber";

import { OrbitControls, Line, useCursor } from "@react-three/drei";

import * as THREE from "three";

import {

  COLORS,

  MAP_ROT,

  SLAB,

  NO_DATA,

  getRisk,

  parseCSV,

  latestStations,

  makeProjector,

  projectedExtent,

  buildDistrictRecords,

  slabGeometry,

  computeHeat,

  heatTexture,

} from "./heatUtils";

import "./NCRHeatMap.css";



const DELHI_URL = "/data/delhi-districts.geojson";

const NCR_URL = "/data/ncr-districts.geojson";

const AQI_URL = "/data/aqi_recent.csv";



const BG = "#0e1217";

const DELHI_CENTER = [77.1, 28.65]; // [lng, lat] fallback camera focus

const ME_DISTANCE = 11;

const noRaycast = () => null; // decorative objects must not block hover/click



const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;



/* ---------------- 3D pieces ---------------- */



// one flat district: carries the heat texture, shows its name on hover

function DistrictSurface({ d, texture, valueAt, mapRef, onHover }) {

  const [hov, setHov] = useState(false);

  useCursor(hov);

  const isDelhi = d.group === "Delhi";



  const tip = (e) => {

    const g = mapRef.current;

    if (!g) return;

    const p = g.worldToLocal(e.point.clone()); // back to map coordinates

    const { value, conf } = valueAt(p.x, -p.z);

    onHover({

      name: isDelhi ? d.name : `${d.name} · ${d.state}`,

      value:

        value == null || conf < 0.25

          ? "No nearby station"

          : `≈ ${Math.round(value)} µg/m³`,

      x: e.nativeEvent.offsetX,

      y: e.nativeEvent.offsetY,

    });

  };



  return (

    <group>

      <mesh

        geometry={d.geometry}

        position={[0, SLAB + 0.003, 0]}

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

        <meshBasicMaterial

          map={texture}

          toneMapped={false}

          polygonOffset

          polygonOffsetFactor={-1}

          polygonOffsetUnits={-1}

        />

      </mesh>



      {d.outlines.map((pts, i) => (

        <Line

          key={i}

          points={pts}

          color={hov ? "#ffffff" : isDelhi ? "#f4f7fa" : "#dbe3ea"}

          lineWidth={hov ? 2.4 : isDelhi ? 1.3 : 0.9}

          transparent

          opacity={hov ? 1 : isDelhi ? 0.7 : 0.4}

          raycast={noRaycast}

        />

      ))}

    </group>

  );

}



// small monitoring-station marker; click to select it

function HeatStation({ s, project, markerScale, onSelect, onHover }) {

  const [hov, setHov] = useState(false);

  useCursor(hov);

  const [x, n] = project([s.longitude, s.latitude]);

  const color = COLORS[getRisk(s.pm25)];

  const r = 0.04 * markerScale;

  const top = 0.16;



  const tip = (e) =>

    onHover({

      name: s.name,

      value: `${Math.round(s.pm25)} µg/m³ measured`,

      x: e.nativeEvent.offsetX,

      y: e.nativeEvent.offsetY,

    });



  return (

    <group position={[x, SLAB, -n]}>

      {/* High-contrast ground halo makes each monitoring station easier to locate. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.012, 0]}
        raycast={noRaycast}
      >
        <ringGeometry args={[0.065 * markerScale, 0.095 * markerScale, 28]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={hov ? 1 : 0.78}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>


      <mesh position={[0, top / 2, 0]} raycast={noRaycast}>

        <cylinderGeometry args={[0.003 * markerScale, 0.003 * markerScale, top, 6]} />

        <meshBasicMaterial color="#ffffff" transparent opacity={0.55} />

      </mesh>

      <mesh position={[0, top, 0]} raycast={noRaycast}>

        <sphereGeometry args={[hov ? r * 1.9 : r * 1.5, 16, 16]} />

        <meshBasicMaterial color="#ffffff" />

      </mesh>

      <mesh position={[0, top, 0]} raycast={noRaycast}>

        <sphereGeometry args={[hov ? r * 1.35 : r, 16, 16]} />

        <meshBasicMaterial color={color} />

      </mesh>



      {/* larger invisible hit area so small markers are easy to click */}

      <mesh

        position={[0, top, 0]}

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

          onSelect(s.id, s.name);

        }}

      >

        <sphereGeometry args={[r * 2.8, 12, 12]} />

        <meshBasicMaterial transparent opacity={0} depthWrite={false} />

      </mesh>

    </group>

  );

}



// bobbing pin with a pulsing ring on the searched station

function SelectedPin({ position, color, pinScale, name, value, onHover }) {

  const root = useRef();

  const head = useRef();

  const ring = useRef();

  const scale = useRef(pinScale);

  const [hov, setHov] = useState(false);

  useCursor(hov);



  useFrame(({ clock }, delta) => {

    const t = clock.elapsedTime;

    scale.current = THREE.MathUtils.damp(scale.current, pinScale, 4, delta);

    root.current.scale.setScalar(scale.current);

    head.current.position.y = 0.5 + Math.sin(t * 2) * 0.06;

    head.current.rotation.y = t * 0.9;

    const p = (t * 0.7) % 1;

    ring.current.scale.setScalar(1 + p * 4);

    ring.current.material.opacity = 0.7 * (1 - p);

  });



  const tip = (e) =>

    onHover({

      name: `Your location · ${name}`,

      value,

      x: e.nativeEvent.offsetX,

      y: e.nativeEvent.offsetY,

    });



  return (

    <group ref={root} position={position}>

      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} raycast={noRaycast}>

        <ringGeometry args={[0.1, 0.13, 48]} />

        <meshBasicMaterial

          color={color}

          transparent

          opacity={0.7}

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

        {/* cone tip points down at the station */}

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



// Glides the camera between "my location" and "entire NCR".

// Runs only for \~1.8s after a change, so manual orbit/zoom stays free.

function CameraRig({ view, goals, trigger }) {

  const camera = useThree((s) => s.camera);

  const controls = useThree((s) => s.controls);

  const size = useThree((s) => s.size);

  const timer = useRef(0);



  useEffect(() => {

    timer.current = 1.8;

  }, [view, trigger, size.width, size.height]);



  useFrame((_, delta) => {

    if (!controls || timer.current <= 0) return;

    timer.current -= delta;



    const aspect = size.width / Math.max(1, size.height);

    const goal =

      view === "ncr"

        ? { target: goals.ncr, dist: 26 * Math.max(1, 1.3 / aspect) } // tall cards need more distance

        : { target: goals.me, dist: ME_DISTANCE };

    const k = 1 - Math.exp(-4 * delta);



    controls.target.lerp(goal.target, k);

    const offset = camera.position.clone().sub(controls.target);

    offset.setLength(THREE.MathUtils.lerp(offset.length(), goal.dist, k));

    camera.position.copy(controls.target).add(offset);

    controls.update();

  });



  return null;

}



/* ---------------- scene (exported so it can be tested on its own) ---------------- */



export function HeatScene({

  districts,

  stations,

  selected,

  texture,

  valueAt,

  project,

  view,

  goals,

  pinColor,

  pinValue,

  onSelectStation,

  onHover,

}) {

  const mapRef = useRef();



  // dark slab under every district: gives the map its edge and fills thin gaps

  const slab = useMemo(

    () => slabGeometry(districts.flatMap((d) => d.polys), project),

    [districts, project]

  );



  const pin = useMemo(() => {

    if (!selected) return null;

    const [x, n] = project([selected.longitude, selected.latitude]);

    return { position: [x, SLAB, -n] };

  }, [selected, project]);



  const far = view === "ncr";



  return (

    <>

      <color attach="background" args={[BG]} />

      <fog attach="fog" args={[BG, 60, 140]} />

      <ambientLight intensity={1} />

      <directionalLight position={[5, 9, 6]} intensity={1.6} />

      <gridHelper args={[160, 160, "#1c2530", "#141b23"]} position={[0, -0.02, 0]} />



      <group ref={mapRef} rotation={[0, MAP_ROT, 0]}>

        <mesh geometry={slab} raycast={noRaycast}>

          <meshStandardMaterial color="#18212b" roughness={0.9} />

        </mesh>



        {districts.map((d) => (

          <DistrictSurface

            key={d.id}

            d={d}

            texture={texture}

            valueAt={valueAt}

            mapRef={mapRef}

            onHover={onHover}

          />

        ))}



        {stations.map((s) => (

          <HeatStation

            key={s.id}

            s={s}

            project={project}

            markerScale={far ? 1.6 : 1}

            onSelect={onSelectStation}

            onHover={onHover}

          />

        ))}



        {pin && selected && (

          <SelectedPin

            position={pin.position}

            color={pinColor}

            pinScale={far ? 2.2 : 1}

            name={selected.name}

            value={pinValue}

            onHover={onHover}

          />

        )}

      </group>



      <CameraRig view={view} goals={goals} trigger={selected?.id} />

    </>

  );

}



/* ---------------- main component ---------------- */



export default function NCRHeatMap({

  selectedId,

  onSelectStation,

  predictedPm25,

  riskColor,

  riskTitle,

}) {

  const [data, setData] = useState(null);

  const [error, setError] = useState("");

  const [view, setView] = useState("me");

  const tipRef = useRef(null);



  useEffect(() => {

    let cancelled = false;

    const getJson = (url, optional) =>

      fetch(url).then((r) => {

        if (!r.ok) {

          if (optional) return null;

          throw new Error(`${url}: ${r.status}`);

        }

        return r.json();

      });



    Promise.all([

      getJson(DELHI_URL, false),

      getJson(NCR_URL, true).catch(() => null), // map still works with Delhi only

      fetch(AQI_URL).then((r) => {

        if (!r.ok) throw new Error(`${AQI_URL}: ${r.status}`);

        return r.text();

      }),

    ])

      .then(([delhi, ncr, csv]) => {

        if (cancelled) return;

        setData({ delhi, ncr, stations: latestStations(parseCSV(csv)) });

      })

      .catch((e) => {

        console.error("Failed to load heat map data:", e);

        if (!cancelled) setError("The heat map could not be loaded.");

      });



    return () => {

      cancelled = true;

    };

  }, []);



  const layers = useMemo(

    () => (data ? [data.delhi, data.ncr].filter(Boolean) : []),

    [data]

  );

  const project = useMemo(() => (layers.length ? makeProjector(layers) : null), [layers]);

  const ext = useMemo(

    () => (project ? projectedExtent(layers, project) : null),

    [layers, project]

  );



  const districts = useMemo(

    () =>

      data && project

        ? buildDistrictRecords(

            [

              { geojson: data.delhi, group: "Delhi" },

              { geojson: data.ncr, group: "NCR" },

            ],

            project

          )

        : [],

    [data, project]

  );



  const heat = useMemo(

    () => (data && project && ext ? computeHeat(data.stations, project, ext) : null),

    [data, project, ext]

  );

  const texture = useMemo(

    () => (heat && ext ? heatTexture(heat.pixels, ext) : null),

    [heat, ext]

  );

  useEffect(() => () => texture?.dispose(), [texture]);



  const selected = useMemo(

    () =>

      data?.stations.find((s) => String(s.id) === String(selectedId)) || null,

    [data, selectedId]

  );



  // searching or clicking a station flies the camera to it

  useEffect(() => {

    if (selectedId) setView("me");

  }, [selectedId]);



  const goals = useMemo(() => {

    if (!project) return null;

    const lift = (lnglat) => {

      const [x, n] = project(lnglat);

      return new THREE.Vector3(x, 0.2, -n).applyAxisAngle(new THREE.Vector3(0, 1, 0), MAP_ROT);

    };

    return {

      ncr: new THREE.Vector3(0, 0.2, 0),

      me: lift(selected ? [selected.longitude, selected.latitude] : DELHI_CENTER),

    };

  }, [project, selected]);



  // tooltip updated through the DOM so pointer moves don't re-render React

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



  if (error) {

    return <div className="heat-card heat-state">{error}</div>;

  }

  if (!data || !project || !goals || !texture) {

    return (

      <div className="heat-card heat-state">

        <span className="heat-dot" />

        Loading the NCR heat map…

      </div>

    );

  }



  const pinColor = "#ff4d4d";

  const hasPrediction = Number.isFinite(Number(predictedPm25)) && predictedPm25 !== null;

  const pinValue = hasPrediction

    ? `${Number(predictedPm25).toFixed(1)} µg/m³ forecast`

    : selected

    ? `${Math.round(selected.pm25)} µg/m³ measured`

    : "";



  // initial camera: along the usual viewing angle, looking at the selected station

  const start = new THREE.Vector3(-4, 7, 9).normalize().multiplyScalar(ME_DISTANCE).add(goals.me);



  return (

    <div className="heat-card">

      <div className="heat-header">

        <div>

          <span className="heat-kicker">NCR HEAT MAP</span>

          <h3>Where you are in the region</h3>

          <p>

            Latest measured PM2.5, estimated between stations. The cards show the

            model's forecast for your location.

          </p>

        </div>



        <div className="heat-views" role="group" aria-label="Map view">

          <button

            type="button"

            className={view === "me" ? "on" : ""}

            aria-pressed={view === "me"}

            onClick={() => setView("me")}

          >

            My location

          </button>

          <button

            type="button"

            className={view === "ncr" ? "on" : ""}

            aria-pressed={view === "ncr"}

            onClick={() => setView("ncr")}

          >

            Entire NCR

          </button>

        </div>

      </div>



      <div className="heat-canvas">

        <Canvas

          camera={{ position: start.toArray(), fov: 35, near: 1, far: 300 }}

          dpr={[1, 2]}

        >

          <HeatScene

            districts={districts}

            stations={data.stations}

            selected={selected}

            texture={texture}

            valueAt={heat.valueAt}

            project={project}

            view={view}

            goals={goals}

            pinColor={pinColor}

            pinValue={pinValue}

            onSelectStation={onSelectStation}

            onHover={showTip}

          />

          <OrbitControls

            makeDefault

            enablePan={false}

            enableDamping

            minDistance={5}

            maxDistance={60}

            minPolarAngle={0.35}

            maxPolarAngle={1.35}

            target={goals.me.toArray()}

          />

        </Canvas>

      </div>



      {/* hover tooltip */}

      {/* Small on-map guide explains which marks can be inspected. */}
      <div className="heat-hint" aria-label="How to explore the heat map">
        <span className="heat-hint-marker" aria-hidden="true" />
        <span><strong>Monitoring station</strong> · click for measured PM2.5</span>
        <span className="heat-hint-separator" aria-hidden="true">•</span>
        <span>Hover a district for an estimate</span>
      </div>

      <div className="heat-tip" ref={tipRef}>

        <span />

        <b />

      </div>



      {selected && (

        <div className="heat-chip">

          <i style={{ background: pinColor }} />

          <div>

            <strong>{selected.name}</strong>

            <span>

              Measured {Math.round(selected.pm25)} µg/m³

              {hasPrediction ? ` · Forecast ${Number(predictedPm25).toFixed(1)} µg/m³` : ""}

              {riskTitle && hasPrediction ? ` · ${riskTitle}` : ""}

            </span>

          </div>

        </div>

      )}



      <div className="heat-legend">

        <div className="heat-legend-bar" />

        <div className="heat-legend-ticks">

          <span style={{ left: "0%" }}>0</span>

          <span style={{ left: "20%" }}>60</span>

          <span style={{ left: "40%" }}>120</span>

          <span style={{ left: "83.3%" }}>250+</span>

        </div>

        <div className="heat-legend-foot">

          <span>PM2.5 µg/m³ · measured</span>

          <span className="heat-legend-nodata">

            <i style={{ background: rgb(NO_DATA) }} /> no nearby station

          </span>

        </div>

      </div>

    </div>

  );

}