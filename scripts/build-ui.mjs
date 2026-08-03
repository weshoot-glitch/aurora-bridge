// The UI is dependency-free static HTML/CSS/JS served straight from ui/.
// This script only sanity-checks the files exist so `npm run build` fails loudly.
import { existsSync } from "fs";
for (const f of ["ui/index.html", "ui/style.css", "ui/app.js"]) {
  if (!existsSync(f)) {
    console.error(`missing ${f}`);
    process.exit(1);
  }
}
console.log("ui ok");
