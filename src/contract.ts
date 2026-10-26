export const defaultBackendPort = 8080;
export const backendPrefix = "/api/";
export const healthPath = "/api/health";
export const buildIdVariable = "BUILD_ID";

export const stateSecrets = [
  "TURBO_VIBE_STATE_BUCKET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
] as const;

export const serviceVariables: Readonly<Record<string, string>> = {
  PORT: "the port the container listens on",
  [buildIdVariable]: "the build ID",
  DATABASE_URL: "the database's connection string",
  WORKOS_REDIRECT_URI: "the sign-in callback",
  ALLOWED_ORIGINS: "the frontend's origins",
  FRONTEND_URL: "the frontend's URL",
  TURBO_VIBE_API_URL: "the API's URL",
};

// Stored by setup only when the config leaves the database's organization out, so no adapter declares it.
export const supabaseOrganization = "SUPABASE_ORGANIZATION";
