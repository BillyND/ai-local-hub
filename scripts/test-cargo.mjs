import {spawnSync} from "node:child_process";
import {cargoPath,manifest} from "./native-build.mjs";
const r=spawnSync(cargoPath(),["test","--manifest-path",manifest],{stdio:"inherit",env:process.env});
if(r.error)throw r.error;
if(r.status!==0)process.exit(r.status||1);
