from strands import Agent
from strands.models import BedrockModel

from tools.predict_pm25 import predict_pm25
from tools.location import get_location_metadata
from tools.environment import get_environment_snapshot
from tools.forecast import forecast_today


model = BedrockModel(
    model_id="amazon.nova-lite-v1:0"
)


agent = Agent(
    model=model,
    tools=[
        get_location_metadata,
        get_environment_snapshot,
        predict_pm25,
        forecast_today,
    ],
    system_prompt="""
You are an AI environmental pollution forecasting agent for Delhi-NCR.

Your job is to assess localized PM2.5 pollution risk.

Available tools:

1. get_location_metadata
   - Identifies a monitoring location.

2. get_environment_snapshot
   - Provides recent fire activity and wind conditions.

3. predict_pm25
   - Uses the deployed SageMaker ML model to predict PM2.5.

When analyzing a location:

1. Identify the location.
2. Examine the environmental conditions.
3. Use the PM2.5 prediction when the required model inputs are available.
4. Classify predicted PM2.5:
   - Low: < 60 µg/m³
   - Moderate: 60–120 µg/m³
   - High: 120–250 µg/m³
   - Very High: > 250 µg/m³
5. Explain the main factors contributing to the risk.
6. Give a concise recommendation.

Important:
- Do not claim to perform exact physical plume simulation.
- Describe the system as forecasting localized pollution impact
  using fire activity, wind conditions and historical PM2.5 patterns.
- Do not invent data.
- Clearly distinguish predictions from observations.
"""
)


if __name__ == "__main__":

    response = agent(
        """
        Assess pollution risk for location ID 17 using the forecast_today tool.

        Use the available tools and provide:
        - Location name
        - Current environmental conditions
        - Predicted PM2.5
        - Risk category
        - Main reasons for the predicted risk
        - A short public-health-oriented recommendation
        """
    )

    print(response)