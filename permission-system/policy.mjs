const defaultPermissions = {
  filesystem: "workspace",
  network: "explicit",
  secrets: "environment-only",
  telemetry: "disabled",
  destructiveActions: "confirm-first"
};

export function evaluatePermission(action) {
  if (action.includes("secret")) {
    return { allowed: false, reason: "Secrets must stay in environment variables." };
  }
  if (action.includes("telemetry")) {
    return { allowed: false, reason: "Telemetry is disabled by default." };
  }
  return { allowed: true, reason: "Action is allowed by the default least-privilege policy." };
}

export { defaultPermissions };
