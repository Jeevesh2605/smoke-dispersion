# Smoke Dispersion Risk Model — Delhi-NCR

Predicts PM2.5 risk at specific locations (schools, hospitals) from
satellite fire activity + wind, so alerts can be targeted instead of
city-wide.

## Folder structure

```
smoke-dispersion-ml/
├── README.md
├── requirements.txt
├── data/
│   ├── raw/           <- fires.csv, aqi_raw.csv, wind_raw.csv go here
│   └── processed/      <- training_data.csv (output of build_features.py)
├── models/              <- model.joblib (output of train_model.py)
└── scripts/
    ├── fetch_aqi.py
    ├── fetch_wind.py
    ├── build_features.py
    └── train_model.py
```

## Step 0 — Environment setup

```bash
cd smoke-dispersion-ml
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## Step 1 — Get an OpenAQ API key (free, 2 minutes)

1. Register at https://explore.openaq.org/register
2. Copy your API key, then set it as an environment variable:

```bash
export OPENAQ_API_KEY="your_key_here"     # Windows: set OPENAQ_API_KEY=your_key_here
```

## Step 2 — Get historical fire data from NASA FIRMS (manual download)

The free API key only covers the last ~60 days (near-real-time), which
isn't enough history to train on. For real historical data:

1. Go to https://firms.modaps.eosdis.nasa.gov/download/
2. Draw/select a region covering Punjab, Haryana, and Delhi-NCR
   (roughly: west 74.5, south 27.5, east 78.5, north 31.5)
3. Pick date range: mid-September to end-November, for 2-3 past years
   (this is peak stubble-burning season — where the real signal is)
4. Sensor: VIIRS (better resolution than MODIS)
5. Format: CSV
6. They'll email you a download link within a few minutes — download it
   and save it as `data/raw/fires.csv`

Check the column names once downloaded — FIRMS archive CSVs typically
include `latitude`, `longitude`, `acq_date`, `confidence`. If yours
differ slightly, adjust `build_features.py` accordingly.

## Step 3 — Pull AQI history (OpenAQ) and wind history (Open-Meteo)

Pick the same date range you used for the fire download. OpenAQ caps
`--radius` at 25000 meters (25km) per request, so a single call from
central Delhi won't reach Noida/Gurugram/Ghaziabad — run it once per
city center instead and combine the results:

```bash
cd scripts

python fetch_aqi.py --lat 28.6139 --lon 77.2090 --radius 25000 \
    --start 2023-10-15 --end 2023-11-30 \
    --out ../data/raw/aqi_delhi.csv

python fetch_aqi.py --lat 28.5355 --lon 77.3910 --radius 25000 \
    --start 2023-10-15 --end 2023-11-30 \
    --out ../data/raw/aqi_noida.csv

python fetch_aqi.py --lat 28.4595 --lon 77.0266 --radius 25000 \
    --start 2023-10-15 --end 2023-11-30 \
    --out ../data/raw/aqi_gurugram.csv

python fetch_aqi.py --lat 28.6692 --lon 77.4538 --radius 25000 \
    --start 2023-10-15 --end 2023-11-30 \
    --out ../data/raw/aqi_ghaziabad.csv

# combine into one file build_features.py will read
python -c "
import pandas as pd
import glob
dfs = [pd.read_csv(f) for f in glob.glob('../data/raw/aqi_*.csv')]
pd.concat(dfs, ignore_index=True).to_csv('../data/raw/aqi_raw.csv', index=False)
"

python fetch_wind.py --lat 28.6139 --lon 77.2090 \
    --start 2023-10-15 --end 2023-11-30 \
    --out ../data/raw/wind_raw.csv
```

Open-Meteo (used by `fetch_wind.py`) doesn't have this radius
restriction — one call from a central Delhi point is fine for wind,
since wind direction doesn't vary as sharply across the NCR area as
pollution monitoring station placement does.

No API key needed for `fetch_wind.py` — Open-Meteo's historical archive
is fully free.

Repeat for as many seasons as you downloaded fire data for (just change
`--start`/`--end` and append to the CSVs, or run separately per year
and concatenate before the next step).

## Step 4 — Build the training table

This is the core step: for every (AQI station, date), it finds nearby
fires from the day before, checks whether the wind was blowing from
the fire toward that station, and pairs that with the station's actual
PM2.5 reading.

```bash
python build_features.py \
    --fires ../data/raw/fires.csv \
    --aqi ../data/raw/aqi_raw.csv \
    --wind ../data/raw/wind_raw.csv \
    --out ../data/processed/training_data.csv \
    --radius-km 300
```

Open `data/processed/training_data.csv` afterward and sanity-check it —
rows where `alignment` is close to 1 (truly downwind) should tend to
have higher `pm25` than rows where `alignment` is close to -1
(upwind). If that pattern isn't visible at all, the radius or lookback
window may need adjusting before you trust the model.

## Step 5 — Train the model

```bash
python train_model.py \
    --data ../data/processed/training_data.csv \
    --model-out ../models/model.joblib
```

This prints a test-set MAE (mean absolute error in µg/m³) and R².
Don't expect a perfect fit — a moderate R² (even ~0.3–0.5) is honest and
usable for a risk *score*, not a precise forecast. Overselling precision
here is exactly the kind of claim that doesn't survive judge scrutiny,
so report it as "elevated risk" tiers, not exact predicted AQI numbers.

## Step 6 — What's next (do this during the hackathon, not before)

- Upload `model.joblib` to S3, deploy it behind a SageMaker Serverless
  Inference endpoint
- Lambda (triggered daily by EventBridge) pulls today's fire + wind
  data, computes the same features for each school/hospital in
  DynamoDB, calls the endpoint, and pushes alerts above a threshold to
  SNS

## Notes on data field names

Both OpenAQ and Open-Meteo's APIs can shift field names over time.
If a script errors on a missing key, print the raw JSON response once
(`print(resp.json())`) to see the actual structure and adjust the
field names in the script — the overall logic won't need to change.