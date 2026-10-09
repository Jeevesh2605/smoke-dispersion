from tools.predict_pm25 import predict_pm25

result = predict_pm25(
    location_id=17,
    pm25_lag_1=115,
    pm25_lag_3=58,
    pm25_lag_7=51.8,
    wind_speed_kmh=9.2,
    wind_direction_deg=279,
    downwind_fire_count_50km=0,
    downwind_fire_count_100km=1,
    downwind_fire_count_200km=3,
    fire_intensity_50km=0,
    fire_intensity_100km=0.02337,
    fire_intensity_200km=0.0664,
    closest_downwind_fire_km=92.27,
)

print(f"Predicted PM2.5: {result:.2f} µg/m³")