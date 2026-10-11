# SmokeGuard

**Location-level PM2.5 risk estimates for Delhi-NCR, with a focus on smoke influence and local monitoring locations.**

SmokeGuard is a three-day hackathon project built for **Track 01 Air: Agentic Smoke Dispersion Forecaster**. It combines NASA satellite fire detections, historical air-quality observations and wind data to estimate PM2.5 at individual monitoring locations. Results are exposed through a FastAPI backend and a React app with a dashboard and an interactive 3D air-quality map.

> **Decision-support prototype:** SmokeGuard is not a replacement for official air-quality forecasts, public-health guidance or validated atmospheric-dispersion models. Its risk bands are application-defined categories, not official AQI classes.

## Why SmokeGuard?

Stubble burning across Punjab and Haryana can contribute to poor air quality across Delhi-NCR. The potential influence at a particular location depends on fire locations, distance, wind conditions and recent air-quality history. A single city-wide reading cannot represent all local differences.

SmokeGuard engineers fire-proximity, wind-related and lagged PM2.5 features for monitoring locations and uses a trained regression model to estimate location-level PM2.5.

## Features

- PM2.5 estimates for **56 monitoring locations** across Delhi-NCR.
- Application-defined **Low, Moderate, High and Very High** risk bands.
- Dashboard showing estimates, risk categories, weather, timestamps and fire-source freshness.
- FastAPI endpoints for predictions, forecasts and location-specific advice.
- The `/agent/*` endpoints, which power the dashboard, call a deployed **Amazon SageMaker Serverless Inference** endpoint.
- Interactive 3D map of Delhi and the surrounding NCR districts.
- Rule-based advice for interpreting each forecast.

## How it works

1. **Collect data:** NASA FIRMS VIIRS fire detections, monitoring-station PM2.5 history and Open-Meteo wind data.
2. **Engineer features:** Build fire-proximity, wind-related and lagged PM2.5 features by location and day.
3. **Train:** Train a Random Forest regression model on a unified dataset of approximately 62,000 observations and 17 columns.
4. **Deploy:** Package the model for a SageMaker Serverless Inference endpoint.
5. **Forecast:** For a location, the `/agent/*` endpoints combine recent PM2.5 readings from `aqi_recent.csv`, the current wind from Open-Meteo and stored fire features, then invoke the SageMaker endpoint. The result is a PM2.5 estimate with an application-defined risk band.
6. **Present:** The React dashboard shows the results. The advice endpoint adds an assessment and a rule-based recommendation.

## Architecture

<img width="1920" height="1080" alt="smokeguard_architecture" src="https://github.com/user-attachments/assets/33c12b46-9947-4296-bec1-8413aeb207e3" />



The model artifacts are stored in Amazon S3 and the custom container image used for deployment is stored in Amazon ECR.

## Model and evaluation

The tables below are the output of `scripts/evaluate_baselines.py`. The model is trained only on data before 2025-01-01, so both splits are held out from training. The script evaluates the model and two simple baselines on the same rows:

- **Previous-reading baseline:** predicts today's PM2.5 with the previous day's reading.
- **Three-day lag-average baseline:** predicts it with the mean of the previous three calendar days at the same station.

Rows missing any of those days are excluded for all three methods.

**Test split (from 2025-07-01), 8,237 rows**

| Model                             | MAE (µg/m³) | RMSE (µg/m³) |        R² |
|:----------------------------------|------------:|-------------:|----------:|
| **Random Forest (unified model)** |   **22.24** |    **55.96** | **0.697** |
| Previous-reading baseline         |       23.62 |        70.13 |     0.524 |
| Three-day lag-average baseline    |       25.98 |        63.69 |     0.607 |

**Validation split (2025-01-01 to 2025-06-30), 5,947 rows**

| Model                             | MAE (µg/m³) | RMSE (µg/m³) |        R² |
|:----------------------------------|------------:|-------------:|----------:|
| **Random Forest (unified model)** |   **19.21** |    **28.68** | **0.405** |
| Previous-reading baseline         |       19.26 |        30.65 |     0.320 |
| Three-day lag-average baseline    |       19.91 |        30.40 |     0.331 |

**How to read these results**

- On the test split the Random Forest has the lowest MAE and RMSE and the highest R². Its MAE is about 6% lower than the previous-reading baseline and about 14% lower than the three-day average, which is a modest gain; the improvements in RMSE and R² are larger.
- On the validation split it is essentially tied with the previous-reading baseline on MAE (19.21 vs 19.26), with smaller gains in RMSE and R².
- Performance depends heavily on the period: R² is 0.405 on validation and 0.697 on test, and RMSE is about twice as large on test (55.96 vs 28.68).
- On the test split RMSE is about 2.5 times MAE, so some predictions have large errors.
- These metrics are not a guarantee of real-world forecast accuracy.

Re-run `python scripts/evaluate_baselines.py` from the repository root to reproduce or refresh them. It also prints the number of rows used and skipped for each split. `scripts/train_unified_model.py` prints its own train, validation and test metrics, plus MAE for high-PM2.5 events (readings of 100, 200, 500 and 1000 µg/m³ and above).

The trained model bundle is expected at `data/processed/unified_random_forest.joblib`. It contains the pipeline, feature definitions and target name. This artifact is excluded from Git; a local copy is required to start the backend.

### Deployed SageMaker endpoint

| Setting             | Value                                 |
|:--------------------|:--------------------------------------|
| Service             | Amazon SageMaker Serverless Inference |
| Region              | `us-east-1`                           |
| Endpoint            | `smoke-forecaster`                    |
| Model               | `smoke-forecaster-custom-model`       |
| Memory              | 2,048 MB                              |
| Maximum concurrency | 5                                     |

A live inference test returned a prediction of approximately **85.60 µg/m³**, matching local inference from the model bundle at the time of testing.

### Application-defined risk bands

| Band      |    PM2.5 concentration |
|:----------|-----------------------:|
| Low       |         Below 60 µg/m³ |
| Moderate  |  60 to below 120 µg/m³ |
| High      | 120 to below 250 µg/m³ |
| Very High |    250 µg/m³ and above |

These thresholds are project categories defined in `app.py` and `agent/agent.py`. They are **not official AQI categories**.

## Data sources

| Source                                                                                   | Use                       | Notes                                                                                          |
|:-----------------------------------------------------------------------------------------|:--------------------------|:-----------------------------------------------------------------------------------------------|
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) — VIIRS on NOAA-20, NOAA-21 and SNPP | Satellite fire detections | 133,228 historical detections across the study region                                          |
| Monitoring-station datasets, including CPCB-related observations                         | Historical PM2.5          | Used to build the station-level history and training features                                  |
| [Open-Meteo](https://open-meteo.com/)                                                    | Wind                      | Historical daily wind per station (archive API); current wind per location for live forecasts |

The historical pipeline covers **1 October 2024 to 15 December 2025**. The FIRMS study-region bounds are approximately longitude 74.5–78.5 and latitude 27.5–31.5, covering parts of Punjab, Haryana and Delhi-NCR.

### Current-day input files

| File                                     | Purpose                                      |
|:-----------------------------------------|:---------------------------------------------|
| `data/raw/aqi_recent.csv`                | Recent monitoring-station PM2.5 observations |
| `data/raw/firms_nrt.csv`                 | Near-real-time fire detections               |
| `data/raw/wind_today.csv`                | Current wind input                           |
| `data/processed/today_fire_features.csv` | Engineered fire features for the current day |
| `data/processed/location_metadata.csv`   | Monitoring-location metadata (56 locations)  |

Regenerating features does not guarantee that the underlying source data is current. Check the dashboard's fire-source freshness indicator before interpreting results.

## API

The backend uses FastAPI and Uvicorn (`app.py`). CORS allows `http://localhost:5173` and `http://127.0.0.1:5173`.

| Route                           | Method | What it does                                                                                                                                  | Model used                                   |
|:--------------------------------|:-------|:----------------------------------------------------------------------------------------------------------------------------------------------|:---------------------------------------------|
| `/health`                       | GET    | Health check                                                                                                                                  | None                                         |
| `/predict`                      | POST   | PM2.5 and risk band from the 13 model inputs sent in the JSON body                                                                            | Local model bundle                           |
| `/forecast/{location_id}`       | GET    | Prediction from the latest row for that location in `data/processed/model_training_data.csv` (historical data, so not a live forecast)        | Local model bundle                           |
| `/agent/forecast/{location_id}` | GET    | Current forecast from recent PM2.5 readings, current wind and stored fire features; returns an error if fewer than 7 recent readings exist     | SageMaker endpoint                           |
| `/agent/advice/{location_id}`   | GET    | The same forecast plus an assessment and a rule-based recommendation; this is the route the dashboard calls                                   | SageMaker endpoint                           |

`/predict` expects `location_id` plus `pm25_lag_1`, `pm25_lag_3`, `pm25_lag_7`, `wind_speed_kmh`, `wind_direction_deg`, `downwind_fire_count_50km`/`100km`/`200km`, `fire_intensity_50km`/`100km`/`200km` and `closest_downwind_fire_km`.

## 3D air map

The landing page includes an interactive 3D map built with three.js, `@react-three/fiber` and `@react-three/drei`.

- **Regional coverage:** Delhi districts and 24 NCR districts outside Delhi.
- **Risk colours:** District colours represent the project's Low, Moderate, High and Very High thresholds.
- **Relative height:** The district with the highest PM2.5 value is tallest and the lowest is shortest; use the colour and tooltip value to interpret the level.
- **Interaction:** Hover for district or station names and click for a detail card.
- **Views:** Switch between *Entire NCR* and *Delhi*.
- **Station markers:** Every station in `aqi_recent.csv` is drawn above its district.
- **Highest-value marker:** A pin marks the district with the highest PM2.5 value in the region.

District values use the average of the latest observed PM2.5 readings from stations inside each district. Districts without a station use an inverse-distance-weighted estimate from other stations and are labelled accordingly. **The map displays observations from `aqi_recent.csv`, not model predictions.**

`aqi_recent.csv` contains 63 stations, while forecasts cover the 56 locations in `location_metadata.csv`, so the map's station count can differ from the forecast count.

> Smoke plumes, fire markers and haze are illustrative visuals. Their positions are placeholders and are not live NASA FIRMS detections.

### NCR districts represented

The list below follows the [NCR Planning Board's constituent-district listing](https://ncrpb.nic.in/ncrconstituent.html).

| Sub-region        | Districts                                                                                                                       |
|:------------------|:--------------------------------------------------------------------------------------------------------------------------------|
| Haryana (14)      | Faridabad, Gurugram, Nuh, Rohtak, Sonipat, Rewari, Jhajjar, Panipat, Palwal, Bhiwani, Charkhi Dadri, Mahendragarh, Jind, Karnal |
| Uttar Pradesh (8) | Meerut, Ghaziabad, Gautam Buddha Nagar, Bulandshahr, Baghpat, Hapur, Shamli, Muzaffarnagar                                      |
| Rajasthan (2)     | Alwar, Bharatpur                                                                                                                |

The 24 NCR district boundaries come from [udit-001/india-maps-data](https://github.com/udit-001/india-maps-data), based on 2011-census-era district boundaries. Rajasthan's newer districts, including Khairthal-Tijara and Deeg, are therefore still represented within Alwar and Bharatpur on this map.

## Project structure

```
smoke-dispersion/
├── app.py                  # FastAPI backend
├── requirements.txt
├── agent/
│   ├── agent.py            # Strands agent definition (Bedrock model configured, not verified)
│   ├── test_predict.py
│   └── tools/              # forecast, environment, location, predict_pm25 (SageMaker)
├── scripts/                # data collection, feature engineering, training, inference test
├── data/
│   ├── raw/                # aqi_recent.csv, firms_nrt.csv, wind_today.csv, candidate_stations.csv
│   └── processed/          # location_metadata.csv, today_fire_features.csv (+ metadata JSON)
└── frontend/               # React + Vite app
    ├── public/data/        # GeoJSON and aqi_recent.csv for the map
    └── src/                # App.jsx (landing page and map), Dashboard.jsx, components/NCRMap.jsx
```

## Getting started

### Prerequisites

- Python 3 and `pip`.
- Node.js (LTS recommended) and npm.
- **The model bundle** at `data/processed/unified_random_forest.joblib`. `app.py` loads it at startup, so the backend will not start without it. It is excluded from Git; see [Rebuild the data and model](#optional-rebuild-the-data-and-model).
- **AWS credentials** permitted to invoke the `smoke-forecaster` SageMaker endpoint in `us-east-1`. They are needed for `/agent/*`, which the dashboard calls.
- `data/processed/model_training_data.csv`, only if you want to use `/forecast/{location_id}`. It is excluded from Git.

### 1. Clone the repository

```bash
git clone https://github.com/Jeevesh2605/smoke-dispersion.git
cd smoke-dispersion
```

### 2. Start the backend

From the repository root:

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Make your AWS credentials available to Boto3, for example by running `aws configure`. Do not commit credentials or `.env` files.

```bash
python -m uvicorn app:app --reload
```

Check that it is running:

```bash
curl http://127.0.0.1:8000/health
```

### 3. Start the frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open the URL printed by Vite (usually `http://localhost:5173`). The dashboard calls the backend at the `API_URL` constant in `frontend/src/Dashboard.jsx`, which is set to `http://127.0.0.1:8000`.

The 3D map reads these files from `frontend/public/data/`:

| File                      | Content                                                                                                           |
|:--------------------------|:------------------------------------------------------------------------------------------------------------------|
| `delhi-districts.geojson` | Delhi district boundaries                                                                                         |
| `ncr-districts.geojson`   | The 24 NCR districts listed above                                                                                 |
| `aqi_recent.csv`          | Latest station observations (`location_id`, `location_name`, `latitude`, `longitude`, `date`, `pm25`)             |

### Optional: rebuild the data and model

Scripts use paths relative to the repository root, so run them from there (for example `python scripts/train_unified_model.py`). Review each script's arguments and prerequisites first; several are documented at the top of the file.

| Script                                    | Role                                                                          |
|:------------------------------------------|:------------------------------------------------------------------------------|
| `scan_stations.py`                        | Monitoring-station discovery                                                  |
| `fetch_aqi_by_stations.py`                | Station-level air-quality data collection                                     |
| `fetch_wind.py`                           | Daily wind per station from the Open-Meteo archive (2024-10-01 to 2025-12-15) |
| `build_historical_dispersion_features.py` | Historical fire-proximity and wind feature engineering                        |
| `build_unified_dataset.py`                | Unified training-data construction                                            |
| `add_lags_unified.py`                     | Lagged PM2.5 feature creation                                                 |
| `train_unified_model.py`                  | Random Forest training; saves the model bundle                                |
| `build_today_features.py`                 | Current-day feature generation                                                |
| `evaluate_baselines.py`                   | Recompute model and baseline metrics on the validation and test splits        |
| `test_model_inference.py`                 | Model inference test                                                          |

## Limitations

- **Approximate dispersion features:** SmokeGuard does not run a full atmospheric-dispersion simulation.
- **Prediction error:** Error varies by location, event and period. On the test split RMSE (55.96 µg/m³) is about 2.5 times MAE (22.24 µg/m³), so some estimates can be substantially off, and gains over a simple previous-day baseline are modest.
- **Data freshness:** Freshly generated features do not prove that their source data is up to date.
- **Wind inputs differ between training and live use:** Training uses daily wind values (maximum 10 m speed and dominant direction) per station, while live forecasts use the current wind reading at each location. The definitions are not identical, which may affect accuracy.
- **Monitoring-location resolution:** Estimates are tied to monitoring locations, not sensors at individual homes, schools or hospitals.
- **Rule-based advice:** The advice endpoint uses fixed rules. `agent/agent.py` configures a Bedrock model, but Bedrock-powered reasoning is unverified and is not part of the working features.
- **Map semantics:** The map visualizes observed PM2.5, not model predictions; smoke and fire visuals are illustrative.
- **Boundary accuracy:** NCR boundaries are 2011-census-era and come from a different source than the Delhi boundaries, so small gaps or overlaps occur at district borders. Some stations land in a neighbouring district or in no district (for example ITO and Prashant Garden, Khora are in no district; Sector 62, Noida falls in Ghaziabad), so district averages near borders are approximate.

## Technology stack

- **Data and ML:** Python, pandas, scikit-learn (Random Forest), joblib, NASA FIRMS VIIRS, Open-Meteo
- **Backend:** FastAPI, Uvicorn, Boto3
- **Agent tooling:** Strands Agents
- **AWS:** Amazon SageMaker Serverless Inference, Amazon S3, Amazon ECR, Amazon ECS (Fargate), Amazon EC2 (Application Load Balancer), Amazon API Gateway, AWS IAM, AWS Amplify
- **Frontend:** React, Vite, JavaScript, CSS, three.js, `@react-three/fiber`, `@react-three/drei`

## Acknowledgements

- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) for satellite fire detections.
- [Open-Meteo](https://open-meteo.com/) for weather data.
- CPCB and other monitoring-station data providers.
- [udit-001/india-maps-data](https://github.com/udit-001/india-maps-data) for NCR district boundaries; consult that repository's disclaimer.
- [National Capital Region Planning Board](https://ncrpb.nic.in/) for information about constituent NCR districts.

## License

MIT. See [LICENSE](LICENSE).
