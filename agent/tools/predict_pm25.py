import json
import boto3
from strands import tool


@tool
def predict_pm25(
    location_id: int,
    pm25_lag_1: float,
    pm25_lag_3: float,
    pm25_lag_7: float,
    wind_speed_kmh: float,
    wind_direction_deg: float,
    downwind_fire_count_50km: int,
    downwind_fire_count_100km: int,
    downwind_fire_count_200km: int,
    fire_intensity_50km: float,
    fire_intensity_100km: float,
    fire_intensity_200km: float,
    closest_downwind_fire_km: float,
) -> float:
    """
    Predict localized PM2.5 using the deployed SageMaker model.
    """

    payload = {
        "location_id": location_id,
        "pm25_lag_1": pm25_lag_1,
        "pm25_lag_3": pm25_lag_3,
        "pm25_lag_7": pm25_lag_7,
        "wind_speed_kmh": wind_speed_kmh,
        "wind_direction_deg": wind_direction_deg,
        "downwind_fire_count_50km": downwind_fire_count_50km,
        "downwind_fire_count_100km": downwind_fire_count_100km,
        "downwind_fire_count_200km": downwind_fire_count_200km,
        "fire_intensity_50km": fire_intensity_50km,
        "fire_intensity_100km": fire_intensity_100km,
        "fire_intensity_200km": fire_intensity_200km,
        "closest_downwind_fire_km": closest_downwind_fire_km,
    }

    client = boto3.client(
        "sagemaker-runtime",
        region_name="us-east-1",
    )

    response = client.invoke_endpoint(
        EndpointName="smoke-forecaster",
        ContentType="application/json",
        Body=json.dumps(payload),
    )

    result = json.loads(response["Body"].read())

    return float(result["predicted_pm25"][0])