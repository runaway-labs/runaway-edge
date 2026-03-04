// Pre-Race Alerts MVP: Threshold Evaluation Logic

import {
  AlertThreshold,
  MetricType,
  Operator,
  ThresholdEvaluationResult,
  WeatherConditions,
} from "./types.ts";

// Evaluate a single threshold against current conditions
export function evaluateThreshold(
  threshold: AlertThreshold,
  conditions: WeatherConditions
): ThresholdEvaluationResult {
  const currentValue = getMetricValue(threshold.metric_type, conditions);
  const triggered = compareValues(currentValue, threshold.operator, threshold.threshold_value);

  return {
    threshold,
    current_value: currentValue,
    triggered,
  };
}

// Evaluate all thresholds for a race
export function evaluateAllThresholds(
  thresholds: AlertThreshold[],
  conditions: WeatherConditions
): ThresholdEvaluationResult[] {
  return thresholds
    .filter((t) => t.is_active)
    .map((threshold) => evaluateThreshold(threshold, conditions));
}

// Get the triggered thresholds only
export function getTriggeredThresholds(
  thresholds: AlertThreshold[],
  conditions: WeatherConditions
): ThresholdEvaluationResult[] {
  return evaluateAllThresholds(thresholds, conditions).filter((r) => r.triggered);
}

// Get the value for a specific metric from conditions
function getMetricValue(metricType: MetricType, conditions: WeatherConditions): number {
  switch (metricType) {
    case "temperature":
      return conditions.temperature;
    case "aqi":
      return conditions.aqi;
    case "wind_speed":
      return conditions.wind_speed;
    case "precipitation_chance":
      return conditions.precipitation_chance;
    default:
      throw new Error(`Unknown metric type: ${metricType}`);
  }
}

// Compare values using the specified operator
function compareValues(current: number, operator: Operator, threshold: number): boolean {
  switch (operator) {
    case ">":
      return current > threshold;
    case ">=":
      return current >= threshold;
    case "<":
      return current < threshold;
    case "<=":
      return current <= threshold;
    case "=":
      return current === threshold;
    default:
      throw new Error(`Unknown operator: ${operator}`);
  }
}

// Generate alert message from triggered thresholds
export function generateAlertMessage(
  triggeredResults: ThresholdEvaluationResult[],
  conditions: WeatherConditions
): { subject: string; message: string } {
  if (triggeredResults.length === 0) {
    return { subject: "", message: "" };
  }

  const subjects: string[] = [];
  const details: string[] = [];

  for (const result of triggeredResults) {
    const { threshold, current_value } = result;
    const metricLabel = getMetricLabel(threshold.metric_type);
    const operatorLabel = getOperatorLabel(threshold.operator);

    subjects.push(`${metricLabel} Alert`);

    details.push(
      `${metricLabel}: ${current_value}${threshold.unit} (threshold: ${operatorLabel} ${threshold.threshold_value}${threshold.unit})`
    );
  }

  // Deduplicate subject parts
  const uniqueSubjects = [...new Set(subjects)];
  const subject = uniqueSubjects.join(" + ");

  const message = [
    "Weather conditions have exceeded your configured thresholds:",
    "",
    ...details,
    "",
    "Current conditions:",
    `- Temperature: ${conditions.temperature}F`,
    `- AQI: ${conditions.aqi}`,
    `- Wind Speed: ${conditions.wind_speed} mph`,
    `- Precipitation Chance: ${conditions.precipitation_chance}%`,
    "",
    "Please review conditions and consider taking appropriate action.",
  ].join("\n");

  return { subject, message };
}

// Get human-readable label for metric type
function getMetricLabel(metricType: MetricType): string {
  switch (metricType) {
    case "temperature":
      return "Temperature";
    case "aqi":
      return "Air Quality";
    case "wind_speed":
      return "Wind Speed";
    case "precipitation_chance":
      return "Precipitation";
    default:
      return metricType;
  }
}

// Get human-readable label for operator
function getOperatorLabel(operator: Operator): string {
  switch (operator) {
    case ">":
      return "above";
    case ">=":
      return "at or above";
    case "<":
      return "below";
    case "<=":
      return "at or below";
    case "=":
      return "equal to";
    default:
      return operator;
  }
}

// Get unit for a metric type
export function getDefaultUnit(metricType: MetricType): string {
  switch (metricType) {
    case "temperature":
      return "F";
    case "aqi":
      return "";
    case "wind_speed":
      return " mph";
    case "precipitation_chance":
      return "%";
    default:
      return "";
  }
}
