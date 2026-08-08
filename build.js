// Genera js/config.js a partir de js/config.template.js, reemplazando
// los placeholders por las Environment Variables reales.
// Vercel lo corre solo en cada deploy (ver vercel.json / README).
// Para probarlo local: crea un archivo ".env" (mira ".env.example")
// y corre:  node build.js

const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "\n❌ Faltan SUPABASE_URL y/o SUPABASE_ANON_KEY.\n" +
    "   En Vercel: Project Settings → Environment Variables.\n" +
    "   En local: crea un archivo .env (copia .env.example) con esos valores.\n"
  );
  process.exit(1);
}

const templatePath = path.join(__dirname, "js", "config.template.js");
const outPath = path.join(__dirname, "js", "config.js");

let content = fs.readFileSync(templatePath, "utf8");
content = content
  .replace("__SUPABASE_URL__", SUPABASE_URL)
  .replace("__SUPABASE_ANON_KEY__", SUPABASE_ANON_KEY);

fs.writeFileSync(outPath, content);
console.log("✅ js/config.js generado a partir de las Environment Variables.");
