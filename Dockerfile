FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt "scikit-learn==1.7.1" "joblib==1.5.2"

COPY app.py .
COPY agent/ ./agent/

COPY data/processed/unified_random_forest.joblib data/processed/unified_random_forest.joblib
COPY data/processed/location_metadata.csv data/processed/location_metadata.csv
COPY data/processed/model_training_data.csv data/processed/model_training_data.csv
COPY data/processed/today_fire_features.csv data/processed/today_fire_features.csv
COPY data/processed/today_fire_features_metadata.json data/processed/today_fire_features_metadata.json
COPY data/raw/aqi_recent.csv data/raw/aqi_recent.csv

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
