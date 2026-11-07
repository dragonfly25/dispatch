/**
 * Fake credentials for redaction tests, one per supported pattern. Every value is synthetic (never
 * a real key) but shaped like the real thing. Shared by the unit tests and the canary suite.
 */
export const SECRET_SAMPLES = {
  "anthropic-key": "sk-ant-api03-CANARYanthropic0123456789abcdefXYZ",
  "openai-key": "sk-proj-CANARYopenai0123456789abcdefghij",
  "github-token": "ghp_CANARYgithub0123456789abcdefghijkl",
  "github-token-oauth": "gho_CANARYgithub0123456789abcdefghijkl",
  "github-token-server": "ghs_CANARYgithub0123456789abcdefghijkl",
  "github-token-pat": "github_pat_CANARYgithub0123456789_abcdefghij",
  "google-key": "AIzaCANARYgoogle0123456789abcdefghijk",
  "slack-token": "xoxb-CANARY0123456789-slackabcdef",
  "aws-key-id": "AKIACANARY0123456789",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.CANARYsignature0123",
  bearer: "Bearer CANARYbearer0123456789abcdef",
  authorization: "Authorization: Basic Q0FOQVJZOnBhc3N3b3Jk",
  "aws-secret": "aws_secret_access_key=CANARYawssecret0123456789abcdefghijklmno",
  "private-key":
    "-----BEGIN RSA PRIVATE KEY-----\nCANARYprivatekeybody0123456789\nmoreCANARYlines\n-----END RSA PRIVATE KEY-----",
} as const;

/** The unique marker inside every sample; the canary suite greps raw database bytes for it. */
export const CANARY_MARKER = "CANARY";

/** An environment value that is not on any allow-list and must never reach the database. */
export const CANARY_ENV_VALUE = "hunter2-CANARY-env-value-77";
