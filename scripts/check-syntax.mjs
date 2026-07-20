import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const files = [];

function visit(directory) {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) visit(path);
    else if ([".js", ".mjs"].includes(extname(name))) files.push(path);
  }
}

visit(root);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
console.log(`JavaScript syntax is valid in ${files.length} files.`);
