import { build, context } from "esbuild";

const options = {
  entryPoints: ["src/app.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "public/app.js",
  sourcemap: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  // eslint-disable-next-line no-console
  console.log("watching web client...");
} else {
  await build(options);
}
