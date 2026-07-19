export function checkOracle(flowResult, usesRequiredMarkersForReading) {
  // If a flow uses requiredMarkers to determine what to read (e.g. isComplete loops),
  // it MUST be flagged as oracle: true.
  if (usesRequiredMarkersForReading) {
    flowResult.oracle = true;
    flowResult.note = "Idealized upper bound (oracle policy)";
  } else {
    flowResult.oracle = false;
  }
  return flowResult;
}

export function isComplete(accumulated, markers) {
  const missing = markers.filter((m) => !accumulated.includes(m));
  return { ok: missing.length === 0, missing };
}
