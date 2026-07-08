import fs from "fs";
export function load(p){ return fs.readFileSync(p,"utf8"); }
