import { useState } from "react";
import NCRMap from "./components/NCRMap";
import Dashboard from "./Dashboard";
import "./App.css";

export default function App() {
  const [page, setPage] = useState("home");

  if (page === "dashboard") {
    return <Dashboard onBack={() => setPage("home")} />;
  }

  return (
    <main className="app">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">SMOKEGUARD · AIR INTELLIGENCE</p>

          <h1>
            Know the air
            <br />
            before you step
            <br />
            outside.
          </h1>

          <p className="subtitle">
            AI-powered smoke dispersion forecasting for communities across Delhi-NCR.
          </p>

          <button
            className="primary-button"
            onClick={() => setPage("dashboard")}
          >
            Check air quality around me →
          </button>
        </div>

        <div className="map-wrapper">
          <NCRMap />
        </div>
      </section>
    </main>
  );
}