# SmokeGuard

**Location-level PM2.5 risk estimates for Delhi-NCR, with a focus on
smoke influence and local monitoring locations.**

SmokeGuard is a three-day hackathon project built for **Track 01 Air:
Agentic Smoke Dispersion Forecaster**. It combines NASA satellite fire
detections, historical air-quality observations and wind data to
estimate PM2.5 at individual monitoring locations. Results are exposed
through a FastAPI backend and a React dashboard with an interactive 3D
air-quality map.

> **Decision-support prototype:** SmokeGuard is not a replacement for
> official air-quality forecasts, public-health guidance or validated
> atmospheric-dispersion models. Its risk bands are application-defined
> categories, not official AQI classes.

## Why SmokeGuard?

Stubble burning across Punjab and Haryana can contribute to poor air
quality across Delhi-NCR. The potential influence at a particular
location depends on fire locations, distance, wind conditions and recent
air-quality history. A single city-wide reading cannot represent all
local differences.

SmokeGuard engineers fire-proximity, wind-related and lagged PM2.5
features for monitoring locations and uses a trained regression model to
estimate location-level PM2.5.

## Features

- PM2.5 estimates for **56 monitoring locations** across Delhi-NCR.
- Application-defined **Low, Moderate, High and Very High** risk bands.
- Dashboard showing estimates, risk categories, weather, timestamps and
  fire-source freshness.
- FastAPI endpoints for forecasts and location-specific advice.
- Inference through an **Amazon SageMaker Serverless Inference**
  endpoint.
- Interactive 3D map of Delhi and surrounding NCR districts.
- Rule-based advice for interpreting the forecast.

## How it works

1.  **Collect data:** NASA FIRMS VIIRS fire detections,
    monitoring-station PM2.5 history and Open-Meteo wind data.
2.  **Engineer features:** Build fire-proximity, wind-related and lagged
    PM2.5 features by location and day.
3.  **Train:** Train a Random Forest regression model on a unified
    dataset of approximately 62,000 observations and 17 columns.
4.  **Deploy:** Package the model for a SageMaker Serverless Inference
    endpoint.
5.  **Predict:** Combine current input files and location metadata,
    invoke the model endpoint and return a PM2.5 estimate with an
    application-defined risk band.
6.  **Present:** Display the results in the React dashboard; the advice
    endpoint adds rule-based recommendations.

## Architecture

<!-- ARCHITECTURE DIAGRAM PLACEHOLDER
Add the final architecture diagram here. Suggested location: docs/architecture.png
Keep this section near the top of the README so readers can understand the data flow at a glance.
-->

## Model and evaluation

| Model                             | MAE (µg/m³) | RMSE (µg/m³) |        R² |
|:----------------------------------|------------:|-------------:|----------:|
| **Random Forest (unified model)** |   **21.21** |    **47.06** | **0.681** |
| Previous-reading baseline         |       22.15 |        57.76 |     0.519 |
| Three-day lag-average baseline    |       23.03 |        53.73 |     0.584 |

The Random Forest outperforms both simple baselines on the reported
evaluation. The MAE improvement is modest, while the R² improvement is
larger. RMSE is more than twice MAE, indicating that some predictions
have relatively large errors. These metrics should be interpreted in the
context of the evaluation data and are not a guarantee of real-world
forecast accuracy.

The trained model bundle is expected at
`data/processed/unified_random_forest.joblib`. It contains the pipeline,
feature definitions and target metadata. This artifact is excluded from
Git; a local copy is required to run the backend that loads it.

### Deployed SageMaker endpoint

| Setting             | Value                                 |
|:--------------------|:--------------------------------------|
| Service             | Amazon SageMaker Serverless Inference |
| Region              | `us-east-1`                           |
| Endpoint            | `smoke-forecaster`                    |
| Model               | `smoke-forecaster-custom-model`       |
| Memory              | 2,048 MB                              |
| Maximum concurrency | 5                                     |

A live inference test returned a prediction of approximately **85.60
µg/m³**, matching local inference from the model bundle at the time of
testing.

### Application-defined risk bands

| Band      |    PM2.5 concentration |
|:----------|-----------------------:|
| Low       |         Below 60 µg/m³ |
| Moderate  |  60 to below 120 µg/m³ |
| High      | 120 to below 250 µg/m³ |
| Very High |    250 µg/m³ and above |

These thresholds are configurable project categories. They are **not
official AQI categories**.

## Data sources

| Source                                                                                   | Use                       | Notes                                                         |
|:-----------------------------------------------------------------------------------------|:--------------------------|:--------------------------------------------------------------|
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) — VIIRS on NOAA-20, NOAA-21 and SNPP | Satellite fire detections | 133,228 historical detections across the study region         |
| Monitoring-station datasets, including CPCB-related observations                         | Historical PM2.5          | Used to build the station-level history and training features |
| [Open-Meteo Historical Weather API](https://open-meteo.com/)                             | Wind data                 | Historical wind series used by the feature pipeline           |

The historical pipeline covers **1 October 2024 to 15 December 2025**.
The FIRMS study-region bounds are approximately longitude 74.5–78.5 and
latitude 27.5–31.5, covering parts of Punjab, Haryana and Delhi-NCR.

### Current-day input files

| File                                     | Purpose                                      |
|:-----------------------------------------|:---------------------------------------------|
| `data/raw/aqi_recent.csv`                | Recent monitoring-station PM2.5 observations |
| `data/raw/firms_nrt.csv`                 | Near-real-time fire detections               |
| `data/raw/wind_today.csv`                | Current wind input                           |
| `data/processed/today_fire_features.csv` | Engineered fire features for the current day |
| `data/processed/location_metadata.csv`   | Monitoring-location metadata                 |

Regenerating features does not guarantee that the underlying source data
is current. Check the dashboard’s fire-source freshness indicator before
interpreting results.

## API

The backend uses FastAPI and Uvicorn.

| Route                           | Purpose                                                 |
|:--------------------------------|:--------------------------------------------------------|
| `GET /health`                   | Health check                                            |
| `/predict`                      | PM2.5 prediction through the SageMaker endpoint         |
| `/forecast/{location_id}`       | Forecast for a monitoring location                      |
| `/agent/forecast/{location_id}` | Agent-oriented forecast for a location                  |
| `/agent/advice/{location_id}`   | Location-specific recommendations; currently rule-based |

For exact request bodies, response schemas and HTTP methods, inspect the
FastAPI route definitions in `app.py` before integrating another client.

## 3D air map

The dashboard includes an interactive 3D map built with three.js,
`@react-three/fiber` and `@react-three/drei`.

- **Regional coverage:** Delhi districts and 24 NCR districts outside
  Delhi.
- **Risk colours:** District colours represent the project’s Low,
  Moderate, High and Very High thresholds.
- **Relative height:** The district with the highest PM2.5 value is
  tallest and the lowest is shortest; use the colour and tooltip value
  to interpret the level.
- **Interaction:** Hover for district or station names and click for a
  detail card.
- **Views:** Switch between *Entire NCR* and *Delhi*.
- **Station markers:** Stations represented in `aqi_recent.csv` are
  drawn above their districts.
- **Highest-value marker:** A pin marks the district with the highest
  PM2.5 value in the region.

District values use the average of the latest observed PM2.5 readings
from stations inside each district. Districts without a station use an
inverse-distance-weighted estimate from nearby stations and are labelled
accordingly. **The map displays observations from `aqi_recent.csv`, not
model predictions.**

> Smoke plumes, fire markers and haze are illustrative visuals. Their
> positions are placeholders and are not live NASA FIRMS detections.

### NCR districts represented

The list below follows the [NCR Planning Board’s constituent-district
listing](https://ncrpb.nic.in/ncrconstituent.html).

| Sub-region        | Districts                                                                                                                       |
|:------------------|:--------------------------------------------------------------------------------------------------------------------------------|
| Haryana (14)      | Faridabad, Gurugram, Nuh, Rohtak, Sonipat, Rewari, Jhajjar, Panipat, Palwal, Bhiwani, Charkhi Dadri, Mahendragarh, Jind, Karnal |
| Uttar Pradesh (8) | Meerut, Ghaziabad, Gautam Buddha Nagar, Bulandshahr, Baghpat, Hapur, Shamli, Muzaffarnagar                                      |
| Rajasthan (2)     | Alwar, Bharatpur                                                                                                                |

The 24 NCR district boundary files are sourced from
[udit-001/india-maps-data](https://github.com/udit-001/india-maps-data),
based on 2011-census-era district boundaries. Rajasthan’s newer
districts, including Khairthal-Tijara and Deeg, are therefore still
represented within Alwar and Bharatpur in this map.

## Getting started

### Prerequisites

- Python installed locally.
- Node.js (LTS recommended) and npm.
- AWS credentials permitted to invoke the `smoke-forecaster` SageMaker
  endpoint in `us-east-1`.
- The model bundle at `data/processed/unified_random_forest.joblib` and
  the runtime data files listed above.
- The map’s GeoJSON and station-data files under
  `frontend/public/data/`.

The model bundle and some data artifacts are not committed to Git. This
README does not provide a model-artifact download workflow.

### 1. Clone the repository

``` bash
git clone https://github.com/Jeevesh2605/smoke-dispersion.git
cd smoke-dispersion
```

### 2. Start the backend

From the repository root:

``` bash
python -m venv .venv
source .venv/bin/activate
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Ensure your AWS credentials are available to Boto3. For example,
configure a local AWS profile with the AWS CLI if needed. Do not commit
credentials or `.env` files.

Start the FastAPI app:

``` bash
python -m uvicorn app:app --reload
```

Check the health endpoint:

``` bash
curl http://127.0.0.1:8000/health
```

The backend also loads the local model bundle during startup, so the
artifact must be present even if predictions are sent to the deployed
endpoint.

### 3. Start the dashboard

In a second terminal:

``` bash
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite (commonly `http://localhost:5173`).
Ensure the frontend’s API base URL points to the running backend; check
the frontend configuration for the exact variable or setting used by
this project.

The 3D map expects these files under `frontend/public/data/`:

| File                      | Content                                                                                                           |
|:--------------------------|:------------------------------------------------------------------------------------------------------------------|
| `delhi-districts.geojson` | Delhi district boundaries                                                                                         |
| `ncr-districts.geojson`   | The 24 NCR districts listed above                                                                                 |
| `aqi_recent.csv`          | Latest station observations, including `location_id`, `location_name`, `latitude`, `longitude`, `pm25` and `date` |

### Optional: data and model pipeline

The repository includes scripts for station discovery, data collection,
feature engineering and model training. Review each script’s arguments
and prerequisites before running it; execution order and data
dependencies may depend on the local files available.

| Script                                    | Role                                                   |
|:------------------------------------------|:-------------------------------------------------------|
| `scan_stations.py`                        | Monitoring-station discovery                           |
| `fetch_aqi_by_stations.py`                | Station-level air-quality data collection              |
| `fetch_wind.py`                           | Wind-data collection                                   |
| `build_historical_dispersion_features.py` | Historical fire-proximity and wind feature engineering |
| `build_unified_dataset.py`                | Unified training-data construction                     |
| `add_lags_unified.py`                     | Lagged PM2.5 feature creation                          |
| `train_unified_model.py`                  | Random Forest training and model-bundle creation       |
| `build_today_features.py`                 | Current-day feature generation                         |

## Limitations

- **Approximate dispersion features:** SmokeGuard does not run a full
  atmospheric-dispersion simulation.
- **Prediction error:** Error varies by location and event. The reported
  RMSE (47.06 µg/m³) is more than twice the MAE (21.21 µg/m³), so some
  estimates can be substantially off.
- **Data freshness:** Freshly generated features do not prove that their
  source data is up to date.
- **Wind coverage:** The current pipeline uses wind data for Delhi;
  local wind differences across the wider NCR are not individually
  represented.
- **Monitoring-location resolution:** Estimates are tied to monitoring
  locations, not sensors at individual homes, schools or hospitals.
- **Rule-based advice:** The advice endpoint uses fixed rules.
  Bedrock-powered reasoning is not represented as a working feature.
- **Map semantics:** The map visualizes observed PM2.5, not model
  predictions; smoke and fire visuals are illustrative.
- **Boundary vintage:** The NCR boundary data is based on
  2011-census-era districts, and separate Delhi/NCR boundary sources may
  produce small gaps or overlaps.

## Technology stack

- **Data and ML:** Python, NASA FIRMS VIIRS, Open-Meteo, Random Forest
  regression, joblib
- **Backend:** FastAPI, Uvicorn, Boto3
- **AWS:** Amazon SageMaker Serverless Inference, Amazon S3, Amazon ECR
- **Frontend:** React, Vite, JavaScript, CSS, three.js,
  `@react-three/fiber`, `@react-three/drei`

## Acknowledgements

- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) for satellite fire
  detections.
- [Open-Meteo](https://open-meteo.com/) for historical weather data.
- CPCB and other monitoring-station data providers.
- [udit-001/india-maps-data](https://github.com/udit-001/india-maps-data)
  for NCR district boundaries; consult that repository’s disclaimer.
- [National Capital Region Planning Board](https://ncrpb.nic.in/) for
  information about constituent NCR districts.

## License

MIT
