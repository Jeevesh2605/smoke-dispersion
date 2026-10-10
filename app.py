from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
import joblib
import os

MODEL_PATH = "data/processed/unified_random_forest.joblib"
METADATA_PATH = "data/processed/location_metadata.csv"

bundle = joblib.load(MODEL_PATH)

pipeline = bundle["pipeline"]
features = bundle["features"]

metadata = pd.read_csv(METADATA_PATH)

location_lookup = (
    metadata
    .set_index("location_id")
    .to_dict("index")
)

app = FastAPI(
    title="Smoke Dispersion PM2.5 Forecaster",
    version="1.0.0"
)

# CORS — allow React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        *[
            origin.strip().rstrip("/")
            for origin in os.getenv("FRONTEND_ORIGINS", "").split(",")
            if origin.strip()
        ],
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PredictionInput(BaseModel):
    pm25_lag_1: float
    pm25_lag_3: float
    pm25_lag_7: float
    wind_speed_kmh: float
    wind_direction_deg: float
    downwind_fire_count_50km: float
    downwind_fire_count_100km: float
    downwind_fire_count_200km: float
    fire_intensity_50km: float
    fire_intensity_100km: float
    fire_intensity_200km: float
    closest_downwind_fire_km: float
    location_id: int


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.post("/predict")
def predict(data: PredictionInput):

    location_id = data.location_id

    if location_id not in location_lookup:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown location_id: {location_id}"
        )

    input_df = pd.DataFrame([data.model_dump()])
    input_df = input_df[features]

    prediction = pipeline.predict(input_df)[0]

    if prediction < 60:
        risk_level = "Low"
    elif prediction < 120:
        risk_level = "Moderate"
    elif prediction < 250:
        risk_level = "High"
    else:
        risk_level = "Very High"

    location = location_lookup[location_id]

    return {
        "location_id": location_id,
        "location_name": location["location_name"],
        "latitude": location["latitude"],
        "longitude": location["longitude"],
        "predicted_pm25": round(float(prediction), 2),
        "unit": "µg/m³",
        "risk_level": risk_level
    }


@app.get("/forecast/{location_id}")
def forecast(location_id: int):

    if location_id not in location_lookup:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown location_id: {location_id}"
        )

    df = pd.read_csv(
        "data/processed/model_training_data.csv"
    )

    rows = (
        df[df["location_id"] == location_id]
        .sort_values("date")
    )

    if rows.empty:
        raise HTTPException(
            status_code=404,
            detail="No forecast data available"
        )

    row = rows.iloc[-1]

    input_df = pd.DataFrame([row[features]])

    prediction = float(
        pipeline.predict(input_df)[0]
    )

    if prediction < 60:
        risk_level = "Low"
    elif prediction < 120:
        risk_level = "Moderate"
    elif prediction < 250:
        risk_level = "High"
    else:
        risk_level = "Very High"

    location = location_lookup[location_id]

    return {
        "location_id": location_id,
        "location_name": location["location_name"],
        "latitude": location["latitude"],
        "longitude": location["longitude"],
        "forecast_date": str(row["date"]),
        "predicted_pm25": round(prediction, 2),
        "unit": "µg/m³",
        "risk_level": risk_level,
        "fire_activity": {
            "50km": int(row["downwind_fire_count_50km"]),
            "100km": int(row["downwind_fire_count_100km"]),
            "200km": int(row["downwind_fire_count_200km"])
        },
        "wind": {
            "speed_kmh": float(row["wind_speed_kmh"]),
            "direction_deg": float(row["wind_direction_deg"])
        }
    }


@app.get("/agent/forecast/{location_id}")
def agent_forecast(location_id: int):

    import sys

    sys.path.insert(0, "agent")

    from tools.forecast import forecast_today

    return forecast_today(location_id)


@app.get("/agent/advice/{location_id}")
def agent_advice(location_id: int):

    import sys

    sys.path.insert(0, "agent")

    from tools.forecast import forecast_today

    forecast = forecast_today(location_id)

    if "error" in forecast:
        return forecast

    pm25 = forecast["predicted_pm25"]
    risk = forecast["risk_level"]

    if risk == "Low":
        recommendation = (
            "Outdoor activity can continue normally."
        )

    elif risk == "Moderate":
        recommendation = (
            "Sensitive individuals should consider "
            "reducing prolonged outdoor exposure."
        )

    elif risk == "High":
        recommendation = (
            "Reduce prolonged outdoor activity and "
            "consider using a mask outdoors."
        )

    else:
        recommendation = (
            "Avoid prolonged outdoor exposure and "
            "consider keeping vulnerable people indoors."
        )

    return {
        **forecast,
        "assessment": (
            f"Predicted PM2.5 is {pm25} µg/m³, "
            f"indicating {risk.lower()} pollution risk. "
            f"There are "
            f"{forecast['downwind_fires_50km']} downwind fires "
            f"within 50 km and the closest is "
            f"{forecast['closest_downwind_fire_km']} km away."
        ),
        "recommendation": recommendation
    }