const { createService } = require("./lib/service");
const production = process.env.NODE_ENV === "production";
const publicUrl =
  process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "";
if (
  production &&
  (!process.env.MOONGLE_INITIAL_INVITE ||
    process.env.MOONGLE_INITIAL_INVITE.length < 16)
)
  throw Error(
    "Set MOONGLE_INITIAL_INVITE to a random secret with at least 16 characters before starting the cloud service.",
  );
if (production && !publicUrl.startsWith("https://"))
  throw Error("Set PUBLIC_URL to the cloud HTTPS origin.");
const service = createService({
  dataDir: process.env.MOONGLE_DATA_DIR,
  initialInvite: process.env.MOONGLE_INITIAL_INVITE,
  publicUrl,
  trustProxy: process.env.TRUST_PROXY === "true",
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    publicUrl,
    domain: process.env.GOOGLE_ALLOWED_DOMAIN,
  },
});
service
  .start(
    Number(process.env.PORT) || 3210,
    process.env.HOST || (production ? "0.0.0.0" : "127.0.0.1"),
  )
  .then((a) => console.log(`Moongle: http://localhost:${a.port}`))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
process.on("SIGINT", () => service.close().then(() => process.exit()));
process.on("SIGTERM", () => service.close().then(() => process.exit()));
