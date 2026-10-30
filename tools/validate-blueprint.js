const fs = require("node:fs"),
  yaml = require("js-yaml"),
  Ajv = require("ajv/dist/2020");
(async () => {
  const response = await fetch("https://render.com/schema/render.yaml.json", {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw Error("Render schema could not be retrieved: " + response.status);
  const schema = await response.json();
  const validate = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
  }).compile(schema);
  if (!validate(yaml.load(fs.readFileSync("render.yaml", "utf8"))))
    throw Error(JSON.stringify(validate.errors, null, 2));
  console.log(
    "Render blueprint passes the current official JSON schema. Platform/account validation still requires Render access.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
